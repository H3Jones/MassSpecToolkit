import { AsyncDuckDB, ConsoleLogger, LogLevel, selectBundle } from "@duckdb/duckdb-wasm";
import mvpWasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvpWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import ehWasm from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import ehWorker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";
import DuckDBWorker from "./duckdb-worker.ts?worker&inline";

/** A dataset owns its worker; replacing or discarding it releases the entire database. */
export async function createSpectrumDatabase(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const bundle = await selectBundle({
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  });
  signal?.throwIfAborted();
  if (!bundle.mainWorker) throw new Error("No compatible DuckDB worker is available.");
  // Single-threaded workers also work on GitHub Pages, without COOP/COEP headers.
  // Inline the bootstrap to avoid a separately emitted nested-worker entry.
  const worker = new DuckDBWorker();
  let disposed = false;
  let failure: Error | undefined;
  const pending = new Set<(error: Error) => void>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const reject of pending) reject(failure);
  };
  let resolveLoaded!: () => void;
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });
  worker.addEventListener("message", (event) => {
    const message: unknown = event.data;
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "ms-duckdb-ready") {
      event.stopImmediatePropagation();
      resolveLoaded();
    } else if (message.type === "ms-duckdb-error" && "message" in message) {
      event.stopImmediatePropagation();
      fail(new Error(String(message.message)));
    }
  });
  const db = new AsyncDuckDB(new ConsoleLogger(LogLevel.WARNING), worker);
  worker.addEventListener("error", (event) => {
    fail(new Error(event.message || "The spectrum database worker stopped unexpectedly."));
  });
  worker.addEventListener("messageerror", () => {
    fail(new Error("The spectrum database worker returned an unreadable message."));
  });
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    if (failure) throw failure;
    let rejectFailure!: (error: Error) => void;
    const failed = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    pending.add(rejectFailure);
    try {
      return await Promise.race([operation(), failed]);
    } finally {
      pending.delete(rejectFailure);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", abort);
    fail(new Error("The spectrum database has been closed."));
    // Reject tracked operations and detach listeners before terminating the worker.
    db.detach();
    worker.terminate();
  }
  const abort = () => {
    fail(
      signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Import cancelled.", "AbortError"),
    );
    dispose();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    worker.postMessage({
      type: "ms-duckdb-load",
      url: new URL(bundle.mainWorker, location.href).href,
    });
    await run(() => loaded);
    await run(() => db.instantiate(new URL(bundle.mainModule, location.href).href));
    await run(() => db.open({ path: ":memory:", query: { castBigIntToDouble: true } }));
    const connection = await run(() => db.connect());
    return { connection, run, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

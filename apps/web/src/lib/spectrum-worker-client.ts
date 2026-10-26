import { proxy, wrap } from "comlink";
import type { TxtFormat, SpectrumImportProgress } from "ms-toolkit/core";
import type { SpectrumDataWorkerApi } from "./spectrum-data";
import type { SpectrumDataSource } from "./spectrum-database";

/** File contents and imported measurement columns never pass through the UI thread. */
export interface SpectrumImportOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SpectrumImportProgress) => void;
}

export async function openSpectrumFile(
  file: File,
  spec?: TxtFormat,
  options: SpectrumImportOptions = {},
): Promise<SpectrumDataSource> {
  options.signal?.throwIfAborted();
  const worker = new Worker(new URL("./spectrum-data-worker.ts", import.meta.url), {
    type: "module",
  });
  const remote = wrap<SpectrumDataWorkerApi>(worker);
  let failure: Error | undefined;
  let disposed = false;
  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    worker.terminate();
  };
  const pending = new Set<(error: Error) => void>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const reject of pending) reject(failure);
  };
  const crashed = (error: Error) => {
    fail(error);
    terminate();
  };
  worker.addEventListener("error", (event) => {
    crashed(new Error(event.message || "The spectrum data worker stopped unexpectedly."));
  });
  worker.addEventListener("messageerror", () => {
    crashed(new Error("The spectrum data worker returned an unreadable message."));
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
    options.signal?.removeEventListener("abort", abort);
    fail(new Error("The spectrum data worker has been closed."));
    if (terminated) return;
    void remote.dispose().then(terminate, (error: unknown) => {
      console.error("[ms-toolkit] Spectrum worker cleanup failed", error);
      terminate();
    });
  }
  const abort = () => {
    fail(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException("Import cancelled.", "AbortError"),
    );
    dispose();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    const imported = await run(() =>
      options.onProgress
        ? remote.importFile(
            file,
            spec,
            proxy(async (progress: SpectrumImportProgress) => {
              if (!disposed && !options.signal?.aborted) options.onProgress?.(progress);
            }),
          )
        : remote.importFile(file, spec),
    );
    return {
      ...imported,
      querySelection: (range) => run(() => remote.querySelection(range)),
      queryChart: (request, range) => run(() => remote.queryChart(request, range)),
      queryTablePage: (request, range) => run(() => remote.queryTablePage(request, range)),
      queryTic: (request) => run(() => remote.queryTic(request)),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

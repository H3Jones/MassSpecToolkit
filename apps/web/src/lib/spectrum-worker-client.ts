import { wrap } from "comlink";
import type { TxtFormat } from "ms-toolkit/core";
import type { SpectrumDataWorkerApi } from "./spectrum-data";
import type { SpectrumDataSource } from "./spectrum-database";

/** File contents and imported measurement columns never pass through the UI thread. */
export async function openSpectrumFile(file: File, spec?: TxtFormat): Promise<SpectrumDataSource> {
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
    const alreadyFailed = failure !== undefined;
    fail(new Error("The spectrum data worker has been closed."));
    if (alreadyFailed) {
      terminate();
      return;
    }
    void remote.dispose().then(terminate, (error: unknown) => {
      console.error("[ms-toolkit] Spectrum worker cleanup failed", error);
      terminate();
    });
  }
  try {
    const imported = await run(() => remote.importFile(file, spec));
    return {
      ...imported,
      querySelection: (range) => run(() => remote.querySelection(range)),
      queryChart: (request, range) => run(() => remote.queryChart(request, range)),
      queryTablePage: (request, range) => run(() => remote.queryTablePage(request, range)),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

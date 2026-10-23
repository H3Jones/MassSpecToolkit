import { wrap, type Remote } from "comlink";
import type { MsApi } from "./wasm.ts";

export type {
  AtomCount,
  ElementRangeResult,
  FineIsotopeDistributionResult,
  FineIsotopePeakResult,
  FormulaResult,
  IonResult,
  MassSpectrumResult,
  MassSplitResult,
  MassToleranceUnit,
  PeakAssignmentMatchResult,
  PeakAssignmentResult,
  SpectrumPeakResult,
  SpectrumMetadata,
  SpectrumType,
  TxtDelimiter,
  TxtFormat,
} from "./types.ts";
export type { MsApi } from "./wasm.ts";
export {
  formatAtomHtml,
  formatFormulaHtml,
  formatIonFormulaHtml,
  formatIsotopeLabelHtml,
  renormalizeIntensities,
} from "./utils.ts";

let client: Remote<MsApi> | undefined;
const pendingRequests = new Set<(error: Error) => void>();

/** Returns a shared client that runs the wasm API in a web worker. */
export function getClient(): Remote<MsApi> {
  if (!client) {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const remote = wrap<MsApi>(worker);
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      worker.terminate();
      if (client === remote) client = undefined;
      for (const reject of pendingRequests) reject(error);
    };
    worker.addEventListener("error", (event) => {
      fail(
        new Error(
          event.message || "The calculation worker could not be loaded or stopped unexpectedly.",
        ),
      );
    });
    worker.addEventListener("messageerror", () => {
      fail(new Error("The calculation worker returned an unreadable message."));
    });
    client = remote;
  }
  return client;
}

/** Rejects pending work on worker load/crash errors; a later call starts a fresh worker. */
export async function callClient<T>(request: (worker: Remote<MsApi>) => Promise<T>): Promise<T> {
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  pendingRequests.add(rejectFailure);
  try {
    return await Promise.race([request(getClient()), failure]);
  } finally {
    pendingRequests.delete(rejectFailure);
  }
}

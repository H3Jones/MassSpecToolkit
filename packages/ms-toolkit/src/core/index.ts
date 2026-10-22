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

/** Returns a shared client that runs the wasm API in a web worker. */
export function getClient(): Remote<MsApi> {
  client ??= wrap<MsApi>(new Worker(new URL("./worker.js", import.meta.url), { type: "module" }));
  return client;
}

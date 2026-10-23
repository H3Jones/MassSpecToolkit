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
} from "../generated/wasm/ms_wasm.js";

export interface SpectrumPeakColumns {
  readonly startIndex: number;
  readonly mz: Float64Array;
  readonly intensity: Float64Array;
  readonly signalToNoise: Float64Array;
  readonly signalToNoiseValidity: Uint8Array;
  readonly retentionTime: Float64Array;
  readonly retentionTimeValidity: Uint8Array;
}

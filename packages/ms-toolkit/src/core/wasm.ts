import { transfer } from "comlink";
import init, {
  TxtSpectrumReader,
  assign_peak,
  evaluate_ion,
  fine_isotope_distribution,
  mass_split,
  guess_txt_format,
  parse_txt,
  parse_formula,
  parse_element_ranges,
} from "../generated/wasm/ms_wasm.js";
import type {
  ElementRangeResult,
  FineIsotopeDistributionResult,
  FormulaResult,
  IonResult,
  MassSpectrumResult,
  MassSplitResult,
  MassToleranceUnit,
  PeakAssignmentResult,
  TxtFormat,
  SpectrumPeakColumns,
  SpectrumMetadata,
} from "./types.ts";

let ready: Promise<unknown> | undefined;

function ensureInit(): Promise<unknown> {
  ready ??= init();
  return ready;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Typed wrapper around the wasm module. Initialises it lazily on first use. */
export const api = {
  /** Reads and parses the File here; only bounded columnar batches leave this worker. */
  async ingestTxt(
    file: File,
    spec: TxtFormat | undefined,
    consume: (batch: SpectrumPeakColumns) => Promise<void>,
  ): Promise<{ metadata: SpectrumMetadata; readMs: number; parseMs: number }> {
    await ensureInit();
    const readStartedAt = performance.now();
    const text = await file.text();
    const readMs = performance.now() - readStartedAt;
    let reader: TxtSpectrumReader | undefined;
    try {
      const parseStartedAt = performance.now();
      reader = new TxtSpectrumReader(text, spec, file.name);
      const metadata = reader.metadata();
      const parseMs = performance.now() - parseStartedAt;
      for (let native = reader.next_batch(); native; native = reader.next_batch()) {
        try {
          const batch: SpectrumPeakColumns = {
            startIndex: native.start_index,
            mz: native.mz,
            intensity: native.intensity,
            signalToNoise: native.signal_to_noise,
            signalToNoiseValidity: native.signal_to_noise_validity,
            retentionTime: native.retention_time,
            retentionTimeValidity: native.retention_time_validity,
          };
          const buffers: ArrayBuffer[] = [];
          for (const column of [
            batch.mz,
            batch.intensity,
            batch.signalToNoise,
            batch.signalToNoiseValidity,
            batch.retentionTime,
            batch.retentionTimeValidity,
          ]) {
            if (!(column.buffer instanceof ArrayBuffer)) {
              throw new Error("Spectrum columns must have owned, transferable buffers.");
            }
            buffers.push(column.buffer);
          }
          await consume(transfer(batch, buffers));
        } finally {
          native.free();
        }
      }
      return { metadata, readMs, parseMs };
    } catch (error) {
      throw toError(error);
    } finally {
      reader?.free();
    }
  },

  async guessTxtFormat(input: string): Promise<TxtFormat> {
    await ensureInit();
    try {
      return guess_txt_format(input);
    } catch (error) {
      throw toError(error);
    }
  },

  async parseTxt(input: string, spec?: TxtFormat, filename?: string): Promise<MassSpectrumResult> {
    await ensureInit();
    try {
      return parse_txt(input, spec, filename);
    } catch (error) {
      throw toError(error);
    }
  },

  async parseElementRanges(input: string): Promise<ElementRangeResult[]> {
    await ensureInit();
    try {
      return parse_element_ranges(input).ranges;
    } catch (error) {
      throw toError(error);
    }
  },

  async assignPeak(
    observedMz: number,
    tolerance: number,
    toleranceUnit: MassToleranceUnit,
    chargeMin: number,
    chargeMax: number,
    elementRanges: string,
  ): Promise<PeakAssignmentResult> {
    await ensureInit();
    try {
      return assign_peak(observedMz, tolerance, toleranceUnit, chargeMin, chargeMax, elementRanges);
    } catch (error) {
      throw toError(error);
    }
  },

  async parseFormula(input: string): Promise<FormulaResult> {
    await ensureInit();
    try {
      return parse_formula(input);
    } catch (error) {
      throw toError(error);
    }
  },

  async evaluateIon(input: string, charge: number): Promise<IonResult> {
    await ensureInit();
    try {
      return evaluate_ion(input, charge);
    } catch (error) {
      throw toError(error);
    }
  },

  async massSplit(formulaA: string, formulaB: string): Promise<MassSplitResult> {
    await ensureInit();
    try {
      return mass_split(formulaA, formulaB);
    } catch (error) {
      throw toError(error);
    }
  },

  async fineIsotopeDistribution(
    input: string,
    charge: number,
  ): Promise<FineIsotopeDistributionResult> {
    await ensureInit();
    try {
      return fine_isotope_distribution(input, charge);
    } catch (error) {
      throw toError(error);
    }
  },
};

export type MsApi = typeof api;

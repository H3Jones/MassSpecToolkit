import { transfer } from "comlink";
import init, {
  StreamingTxtSpectrumReader,
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
  SpectrumImportProgress,
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
  /** Streams UTF-8 in 64 KiB reads, awaiting insertion before producing another full batch. */
  async ingestTxt(
    file: File,
    spec: TxtFormat | undefined,
    consume: (batch: SpectrumPeakColumns) => Promise<void>,
    onProgress?: (progress: SpectrumImportProgress) => Promise<void>,
  ): Promise<{ metadata: SpectrumMetadata; readMs: number; parseMs: number }> {
    await ensureInit();
    let readMs = 0;
    let parseMs = 0;
    let bytesRead = 0;
    let lastProgressAt = -Infinity;
    let input: ReadableStreamBYOBReader | undefined;
    let ended = false;
    let reader: StreamingTxtSpectrumReader | undefined;
    let failure: Error | undefined;
    const report = async (phase: SpectrumImportProgress["phase"], force = false) => {
      if (!onProgress || (!force && performance.now() - lastProgressAt < 100)) return;
      await onProgress({
        phase,
        bytesRead,
        totalBytes: file.size,
        peakCount: reader?.peak_count() ?? 0,
      });
      lastProgressAt = performance.now();
    };
    const drain = async (reader: StreamingTxtSpectrumReader) => {
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
    };
    try {
      reader = new StreamingTxtSpectrumReader(spec, file.name);
      input = file.stream().getReader({ mode: "byob" });
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = new ArrayBuffer(65_536);
      await report("reading", true);
      for (;;) {
        const readStartedAt = performance.now();
        const { value, done } = await input.read(new Uint8Array(buffer));
        readMs += performance.now() - readStartedAt;
        if (value?.byteLength) {
          buffer = value.buffer;
          bytesRead += value.byteLength;
          const parseStartedAt = performance.now();
          reader.push_chunk(decoder.decode(value, { stream: true }));
          parseMs += performance.now() - parseStartedAt;
          await drain(reader);
          await report("reading");
        }
        if (done) {
          ended = true;
          break;
        }
      }
      if (bytesRead !== file.size)
        throw new Error("The spectrum stream ended before the entire file was read.");
      const parseStartedAt = performance.now();
      reader.push_chunk(decoder.decode());
      reader.finish();
      const metadata = reader.metadata();
      parseMs += performance.now() - parseStartedAt;
      await drain(reader);
      await report("finalizing", true);
      return { metadata, readMs, parseMs };
    } catch (error) {
      failure = toError(error);
      throw failure;
    } finally {
      reader?.free();
      if (input) {
        try {
          if (!ended) await input.cancel(failure);
        } catch (error) {
          console.error("[ms-toolkit] Spectrum stream cleanup failed", error);
        } finally {
          input.releaseLock();
        }
      }
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

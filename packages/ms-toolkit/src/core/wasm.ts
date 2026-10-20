import init, {
  assign_peak,
  evaluate_ion,
  fine_isotope_distribution,
  mass_split,
  parse_formula,
  parse_element_ranges,
} from "../generated/wasm/ms_wasm.js";
import type {
  ElementRangeResult,
  FineIsotopeDistributionResult,
  FormulaResult,
  IonResult,
  MassSplitResult,
  MassToleranceUnit,
  PeakAssignmentResult,
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

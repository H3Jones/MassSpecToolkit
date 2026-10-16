import init, { evaluate_ion, mass_split, parse_formula } from '../generated/wasm/ms_wasm.js';
import type { FormulaResult, IonResult, MassSplitResult } from './types.ts';

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
};

export type MsApi = typeof api;

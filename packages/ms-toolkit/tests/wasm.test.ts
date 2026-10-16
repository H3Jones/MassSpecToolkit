import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { initSync } from '../src/generated/wasm/ms_wasm.js';
import { api } from '../src/core/wasm.ts';

beforeAll(async () => {
  const bytes = await readFile(new URL('../src/generated/wasm/ms_wasm_bg.wasm', import.meta.url));
  initSync({ module: bytes });
});

describe('wasm api', () => {
  it('parses a formula', async () => {
    const result = await api.parseFormula('H2O');
    expect(result.formula).toBe('H2O');
    expect(result.mass).toBeCloseTo(18.0106, 2);
    expect(result.dbe).toBe(0);
  });

  it('evaluates an ion', async () => {
    const result = await api.evaluateIon('H2O', 1);
    expect(result.charge).toBe(1);
    expect(result.mass_to_charge).toBeGreaterThan(17);
    expect(result.dbe).toBe(0);
  });

  it('returns no mass-to-charge ratio for a neutral formula', async () => {
    const result = await api.evaluateIon('H2O', 0);
    expect(result.charge).toBe(0);
    expect(result.mass).toBeCloseTo(18.0106, 2);
    expect(result.mass_to_charge).toBeNull();
  });

  it('splits formulas into their A-only and B-only components', async () => {
    const result = await api.massSplit('C2H6O', 'CH4O2');
    expect(result.formula_a_only?.formula).toBe('CH2');
    expect(result.formula_b_only?.formula).toBe('O');
    expect(result.mass_difference).toBeCloseTo(result.formula_a_only!.mass - result.formula_b_only!.mass, 10);
  });

  it('returns null components for equal formulas', async () => {
    const result = await api.massSplit('H2O', 'H2O');
    expect(result.formula_a_only).toBeNull();
    expect(result.formula_b_only).toBeNull();
    expect(result.mass_difference).toBe(0);
  });

  it('rejects invalid formulas', async () => {
    await expect(api.parseFormula('((')).rejects.toBeInstanceOf(Error);
  });
});

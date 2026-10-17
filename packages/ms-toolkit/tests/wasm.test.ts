import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { initSync } from "../src/generated/wasm/ms_wasm.js";
import { api } from "../src/core/wasm.ts";

beforeAll(async () => {
  const bytes = await readFile(new URL("../src/generated/wasm/ms_wasm_bg.wasm", import.meta.url));
  initSync({ module: bytes });
});

describe("wasm api", () => {
  it("parses a formula", async () => {
    const result = await api.parseFormula("H2O");
    expect(result.formula).toBe("H2O");
    expect(result.mass).toBeCloseTo(18.0106, 2);
    expect(result.dbe).toBe(0);
  });

  it("evaluates an ion", async () => {
    const result = await api.evaluateIon("H2O", 1);
    expect(result.charge).toBe(1);
    expect(result.mass_to_charge).toBeGreaterThan(17);
    expect(result.dbe).toBe(0);
  });

  it("returns no mass-to-charge ratio for a neutral formula", async () => {
    const result = await api.evaluateIon("H2O", 0);
    expect(result.charge).toBe(0);
    expect(result.mass).toBeCloseTo(18.0106, 2);
    expect(result.mass_to_charge).toBeNull();
  });

  it("splits formulas into their A-only and B-only components", async () => {
    const result = await api.massSplit("C2H6O", "CH4O2");
    expect(result.formula_a_only?.formula).toBe("CH2");
    expect(result.formula_b_only?.formula).toBe("O");
    expect(result.mass_difference).toBeCloseTo(
      result.formula_a_only!.mass - result.formula_b_only!.mass,
      10,
    );
  });

  it("returns null components for equal formulas", async () => {
    const result = await api.massSplit("H2O", "H2O");
    expect(result.formula_a_only).toBeNull();
    expect(result.formula_b_only).toBeNull();
    expect(result.mass_difference).toBe(0);
  });

  it("calculates fine isotope peaks and corrects their masses for charge", async () => {
    const neutral = await api.fineIsotopeDistribution("C2H6O", 0);
    const protonated = await api.fineIsotopeDistribution("C2H6O", 1);
    const deprotonated = await api.fineIsotopeDistribution("C2H6O", -1);
    const doublyCharged = await api.fineIsotopeDistribution("C2H6O", 2);

    expect(neutral.peaks).toHaveLength(63);
    expect(neutral.peaks[0]?.label).toBe("12C2 1H6 16O");
    expect(neutral.peaks[0]?.mass_to_charge).toBeNull();
    expect(neutral.retained_probability).toBeGreaterThanOrEqual(0.9999 - 1e-12);
    expect(protonated.peaks).toHaveLength(neutral.peaks.length);
    expect(protonated.peaks[0]?.mass).toBeCloseTo(neutral.peaks[0]!.mass - 0.000548579909065, 12);
    expect(protonated.peaks[0]?.mass_to_charge).toBe(protonated.peaks[0]?.mass);
    expect(protonated.peaks[0]?.abundance).toBe(neutral.peaks[0]?.abundance);
    expect(deprotonated.peaks[0]?.mass).toBeCloseTo(neutral.peaks[0]!.mass + 0.000548579909065, 12);
    expect(doublyCharged.peaks[0]?.mass_to_charge).toBeCloseTo(
      doublyCharged.peaks[0]!.mass / 2,
      12,
    );
  });

  it("rejects invalid formulas", async () => {
    await expect(api.parseFormula("((")).rejects.toBeInstanceOf(Error);
  });
});

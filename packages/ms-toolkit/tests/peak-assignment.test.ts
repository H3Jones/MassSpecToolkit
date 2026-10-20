import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { initSync } from "../src/generated/wasm/ms_wasm.js";
import { api } from "../src/core/wasm.ts";

beforeAll(async () => {
  const bytes = await readFile(new URL("../src/generated/wasm/ms_wasm_bg.wasm", import.meta.url));
  initSync({ module: bytes });
});

describe("element range preview", () => {
  it("parses commas, whitespace, newlines, and optional elements with the Rust parser", async () => {
    await expect(api.parseElementRanges(" C4-100, H8-100\nO2-100\tCl0-2 ")).resolves.toEqual([
      { symbol: "C", mass_number: 12, isotope_was_specified: false, min: 4, max: 100 },
      { symbol: "H", mass_number: 1, isotope_was_specified: false, min: 8, max: 100 },
      { symbol: "O", mass_number: 16, isotope_was_specified: false, min: 2, max: 100 },
      { symbol: "Cl", mass_number: 35, isotope_was_specified: false, min: 0, max: 2 },
    ]);
  });

  it("shows fixed counts as equal minimum and maximum values", async () => {
    await expect(api.parseElementRanges("C4-100, H8-100, Na1 Cl0")).resolves.toEqual([
      { symbol: "C", mass_number: 12, isotope_was_specified: false, min: 4, max: 100 },
      { symbol: "H", mass_number: 1, isotope_was_specified: false, min: 8, max: 100 },
      { symbol: "Na", mass_number: 23, isotope_was_specified: false, min: 1, max: 1 },
      { symbol: "Cl", mass_number: 35, isotope_was_specified: false, min: 0, max: 0 },
    ]);
  });

  it("distinguishes explicit isotope ranges and fixed counts from default isotope ranges", async () => {
    await expect(api.parseElementRanges("C4-100 ^13C0-1 ^18O1")).resolves.toEqual([
      { symbol: "C", mass_number: 12, isotope_was_specified: false, min: 4, max: 100 },
      { symbol: "C", mass_number: 13, isotope_was_specified: true, min: 0, max: 1 },
      { symbol: "O", mass_number: 18, isotope_was_specified: true, min: 1, max: 1 },
    ]);
  });

  it.each([
    ["", "at least one"],
    ["C0-10 C1-2", "more than one range"],
    ["C4-2", "invalid range"],
    ["Xx0-10", "unknown element"],
    ["C0-2147483648", "invalid element range"],
    ["C0-10 invalid", "invalid element range"],
    ["Na2147483648", "invalid element range"],
    ["Na1 Na0-2", "more than one range"],
    ["^13C10-1", "invalid range"],
    ["^999C1", "not in the isotope table"],
    ["^65536C1", "outside the supported range"],
    ["C1 ^12C1", "more than one range"],
    ["^13C0-1 ^13C1", "more than one range"],
  ])("rejects invalid range input %j without returning a partial table", async (text, message) => {
    await expect(api.parseElementRanges(text)).rejects.toThrow(message);
  });
});

describe("peak assignment", () => {
  const glucoseRanges = "C4-100 H8-100 O2-100";

  it.each(["^13C", "^14C", "^54Fe", "^99Tc"])(
    "searches only the explicitly selected isotope %s",
    async (formula) => {
      const ion = await api.evaluateIon(formula, 1);
      const result = await api.assignPeak(ion.mass_to_charge!, 0, "da", 1, 1, `${formula}1`);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({ formula, charge: 1, error_da: 0 });
    },
  );

  it("treats explicit isotope and default isotope counts independently", async () => {
    const ion = await api.evaluateIon("C2^13CH", 1);
    const ranges = "C2 ^13C0-1 H1";
    const result = await api.assignPeak(ion.mass_to_charge!, 0, "da", 1, 1, ranges);
    expect(result.element_ranges).toEqual(await api.parseElementRanges(ranges));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.formula).toBe("C2^13CH");
  });

  it("does not generate isotopes that were not listed", async () => {
    const ion = await api.evaluateIon("^13C", 1);
    const result = await api.assignPeak(ion.mass_to_charge!, 0, "da", 1, 1, "C1");
    expect(result.matches).toEqual([]);
  });

  it("enforces a fixed sodium count through preview and assignment", async () => {
    const ion = await api.evaluateIon("C2H4NaO", 1);
    const ranges = "C1-3 H0-8 O1 Na1 Cl0";
    const result = await api.assignPeak(ion.mass_to_charge!, 0, "da", 1, 1, ranges);
    expect(result.element_ranges).toEqual(await api.parseElementRanges(ranges));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ formula: "C2H4NaO", charge: 1 });
    const twoSodium = await api.evaluateIon("C2H4Na2O", 1);
    const noMatch = await api.assignPeak(twoSodium.mass_to_charge!, 0, "da", 1, 1, ranges);
    expect(noMatch.matches).toEqual([]);
  });

  it("finds the example formula and returns the same ranges as the preview", async () => {
    const result = await api.assignPeak(180.06284, 5, "ppm", 1, 1, glucoseRanges);
    expect(result.observed_mz).toBe(180.06284);
    expect(result.tolerance).toBe(5);
    expect(result.tolerance_unit).toBe("ppm");
    expect(result.charges).toEqual([1]);
    expect(result.element_ranges).toEqual(await api.parseElementRanges(glucoseRanges));
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ formula: "C6H12O6", charge: 1 });
    expect(Math.abs(result.matches[0]!.error_ppm)).toBeLessThan(5);
  });

  it.each([-3, -1, 1, 2])("uses the existing Ion conventions at charge %i", async (charge) => {
    const ion = await api.evaluateIon("C2H7O", charge);
    const observed = ion.mass_to_charge!;
    const result = await api.assignPeak(observed, 0, "da", charge, charge, "O1-1 H7-7 C2-2");
    expect(result.matches).toEqual([
      {
        formula: "C2H7O",
        charge,
        mass: ion.mass,
        mass_to_charge: observed,
        error_da: 0,
        error_ppm: 0,
      },
    ]);
  });

  it("searches both signs of an inclusive charge range while excluding zero", async () => {
    const neutral = await api.parseFormula("H2O");
    const result = await api.assignPeak(neutral.mass, 0.001, "da", -2, 2, "H2-2 O1-1");
    expect(result.charges).toEqual([-2, -1, 1, 2]);
    expect(result.matches.map((hit) => hit.charge).sort((a, b) => a - b)).toEqual([-1, 1]);
    expect(result.matches.every((hit) => hit.formula === "H2O")).toBe(true);
  });

  it.each([-0.0001, 0.0001])(
    "uses theoretical-relative ppm and experimental-minus-theoretical errors for offset %s",
    async (offset) => {
      const ion = await api.evaluateIon("C2H6O", 2);
      const observed = ion.mass_to_charge! + offset;
      const ppm = await api.assignPeak(observed, 5, "ppm", 2, 2, "C2-2 H6-6 O1-1");
      const da = await api.assignPeak(
        observed,
        ion.mass_to_charge! * (5 / 1e6),
        "da",
        2,
        2,
        "C2-2 H6-6 O1-1",
      );
      expect(ppm.matches).toEqual(da.matches);
      expect(ppm.matches).toHaveLength(1);
      const hit = ppm.matches[0]!;
      expect(hit.error_da).toBe(observed - hit.mass_to_charge);
      expect(Math.sign(hit.error_da)).toBe(Math.sign(offset));
      expect(hit.error_ppm).toBe((hit.error_da / hit.mass_to_charge) * 1e6);
    },
  );

  it.each([-2, 1, 2])("filters ppm against theoretical m/z at charge %i", async (charge) => {
    const ion = await api.evaluateIon("C", charge);
    const theoretical = ion.mass_to_charge!;
    const included = await api.assignPeak(
      theoretical * 0.905,
      100_000,
      "ppm",
      charge,
      charge,
      "C1",
    );
    expect(included.matches).toHaveLength(1);
    expect(included.matches[0]!.error_ppm).toBeCloseTo(-95_000, 6);
    const excluded = await api.assignPeak(
      theoretical * 1.105,
      100_000,
      "ppm",
      charge,
      charge,
      "C1",
    );
    expect(excluded.matches).toEqual([]);
  });

  it("sorts matches globally across charges by absolute error, formula, and charge", async () => {
    const result = await api.assignPeak(45, 1, "da", -2, 2, "C1-8 H0-20 O0-4");
    expect(result.matches.length).toBeGreaterThan(2);
    expect(new Set(result.matches.map((hit) => hit.charge)).size).toBeGreaterThan(1);
    const sorted = [...result.matches].sort(
      (a, b) =>
        Math.abs(a.error_da) - Math.abs(b.error_da) ||
        (a.formula < b.formula ? -1 : a.formula > b.formula ? 1 : 0) ||
        a.charge - b.charge,
    );
    expect(result.matches).toEqual(sorted);
    expect(result.matches.every((hit) => Math.abs(hit.error_da) <= 1 && hit.charge !== 0)).toBe(
      true,
    );
  });

  it("returns an explicit empty match list rather than an error when nothing fits", async () => {
    const result = await api.assignPeak(1, 5, "ppm", 1, 2, glucoseRanges);
    expect(result.matches).toEqual([]);
    expect(result.charges).toEqual([1, 2]);
    expect(result.element_ranges).toHaveLength(3);
  });

  it.each([
    [0, 0],
    [2, 1],
    [-256, -1],
    [1, 256],
    [0.5, 1],
    [1, 1.5],
    [NaN, 1],
    [1, Infinity],
  ])("rejects invalid charge bounds %s to %s without integer truncation", async (min, max) => {
    await expect(api.assignPeak(100, 5, "ppm", min, max, glucoseRanges)).rejects.toThrow(/charge/i);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid observed m/z %s", async (mass) => {
    await expect(api.assignPeak(mass, 5, "ppm", 1, 1, glucoseRanges)).rejects.toThrow(
      /observed m\/z/,
    );
  });

  it.each([-1, NaN, Infinity])("rejects invalid tolerances %s", async (error) => {
    await expect(api.assignPeak(100, error, "ppm", 1, 1, glucoseRanges)).rejects.toThrow(
      /tolerance/,
    );
  });

  it("rejects unknown error units and invalid range lists", async () => {
    await expect(
      Reflect.apply(api.assignPeak, api, [100, 5, "unknown", 1, 1, glucoseRanges]),
    ).rejects.toThrow("tolerance unit");
    await expect(api.assignPeak(100, 5, "ppm", 1, 1, "C0-10 C1-2")).rejects.toThrow(
      "more than one range",
    );
  });
});

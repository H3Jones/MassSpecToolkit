import { describe, expect, it } from "vite-plus/test";
import type { AtomCount } from "../src/core/types.ts";
import {
  formatAtomHtml,
  formatFormulaHtml,
  formatIsotopeLabelHtml,
  renormalizeIntensities,
} from "../src/core/utils.ts";

describe("formula HTML formatters", () => {
  it("formats isotope atom labels as superscript elements", () => {
    const atom: AtomCount = {
      symbol: "C",
      mass_number: 13,
      isotope_was_specified: true,
      atom_ram: 13,
      count: 1,
      total_mass: 13,
    };

    expect(formatAtomHtml(atom)).toBe("<sup>13</sup>C");
  });

  describe("intensity normalization", () => {
    it("normalizes to the base peak while preserving row fields and input", () => {
      const peaks = [
        { label: "12C2 1H6 16O", mz: 46.04, int: 0.5 },
        { label: "12C 13C 1H6 16O", mz: 47.04, int: 0.25 },
      ];

      expect(renormalizeIntensities(peaks)).toEqual([
        { label: "12C2 1H6 16O", mz: 46.04, int: 100 },
        { label: "12C 13C 1H6 16O", mz: 47.04, int: 50 },
      ]);
      expect(peaks[0]?.int).toBe(0.5);
    });

    it("rejects empty data and data without a positive intensity", () => {
      expect(() => renormalizeIntensities([])).toThrow("positive intensity");
      expect(() => renormalizeIntensities([{ int: 0 }])).toThrow("positive intensity");
    });

    it("normalizes arrays larger than the JavaScript argument limit", () => {
      const peaks = Array.from({ length: 160_146 }, (_, index) => ({ int: index + 1 }));

      const normalized = renormalizeIntensities(peaks);

      expect(normalized).toHaveLength(peaks.length);
      expect(normalized[0]?.int).toBeCloseTo(100 / peaks.length, 10);
      expect(normalized.at(-1)?.int).toBe(100);
    });
  });

  describe("isotope label HTML formatter", () => {
    it("formats isotope masses and atom counts from a plain-text label", () => {
      expect(formatIsotopeLabelHtml("12C2 1H6 16O")).toBe(
        "<sup>12</sup>C<sub>2</sub><sup>1</sup>H<sub>6</sub><sup>16</sup>O",
      );
    });

    it("preserves isotope order, handles two-letter symbols, and omits counts of one", () => {
      expect(formatIsotopeLabelHtml("13C1 12C 37Cl2")).toBe(
        "<sup>13</sup>C<sup>12</sup>C<sup>37</sup>Cl<sub>2</sub>",
      );
    });

    it("accepts whitespace around and between isotope tokens", () => {
      expect(formatIsotopeLabelHtml("  12C2\t1H6\n16O  ")).toBe(
        formatIsotopeLabelHtml("12C2 1H6 16O"),
      );
      expect(formatIsotopeLabelHtml("  ")).toBe("");
    });

    it.each(["C2H6O", "0C", "12C0", "12C2+", "<img src=x>", "12C2<script>"])(
      "rejects invalid or HTML input: %s",
      (label) => {
        expect(() => formatIsotopeLabelHtml(label)).toThrow("Invalid isotope label token");
      },
    );

    it.each(["9007199254740992C", "12C9007199254740992"])(
      "rejects integers that cannot be represented exactly: %s",
      (label) => {
        expect(() => formatIsotopeLabelHtml(label)).toThrow("safe integers");
      },
    );
  });

  it("formats atom counts as subscript elements", () => {
    const atomCounts: AtomCount[] = [
      {
        symbol: "C",
        mass_number: 12,
        isotope_was_specified: false,
        atom_ram: 12,
        count: 6,
        total_mass: 72,
      },
      {
        symbol: "H",
        mass_number: 1,
        isotope_was_specified: false,
        atom_ram: 1,
        count: 12,
        total_mass: 12,
      },
      {
        symbol: "O",
        mass_number: 16,
        isotope_was_specified: false,
        atom_ram: 16,
        count: 6,
        total_mass: 96,
      },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe("C<sub>6</sub>H<sub>12</sub>O<sub>6</sub>");
  });

  it("formats specified isotope mass numbers as superscript elements", () => {
    const atomCounts: AtomCount[] = [
      {
        symbol: "C",
        mass_number: 13,
        isotope_was_specified: true,
        atom_ram: 13,
        count: 1,
        total_mass: 13,
      },
      {
        symbol: "H",
        mass_number: 1,
        isotope_was_specified: false,
        atom_ram: 1,
        count: 4,
        total_mass: 4,
      },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe("<sup>13</sup>CH<sub>4</sub>");
  });

  it("retains input order and omits a subscript for count one", () => {
    const atomCounts: AtomCount[] = [
      {
        symbol: "O",
        mass_number: 16,
        isotope_was_specified: false,
        atom_ram: 16,
        count: 1,
        total_mass: 16,
      },
      {
        symbol: "N",
        mass_number: 14,
        isotope_was_specified: false,
        atom_ram: 14,
        count: 2,
        total_mass: 28,
      },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe("ON<sub>2</sub>");
  });

  it("escapes symbols before returning HTML", () => {
    const atomCounts: AtomCount[] = [
      {
        symbol: "<img>",
        mass_number: 1,
        isotope_was_specified: false,
        atom_ram: 1,
        count: 1,
        total_mass: 1,
      },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe("&lt;img&gt;");
  });
});

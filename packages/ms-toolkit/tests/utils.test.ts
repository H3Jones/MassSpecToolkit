import { describe, expect, it } from 'vite-plus/test';
import type { AtomCount } from '../src/core/types.ts';
import { formatAtomHtml, formatFormulaHtml } from '../src/core/utils.ts';

describe('formula HTML formatters', () => {
  it('formats isotope atom labels as superscript elements', () => {
    const atom: AtomCount = {
      symbol: 'C',
      mass_number: 13,
      isotope_was_specified: true,
      atom_ram: 13,
      count: 1,
      total_mass: 13,
    };

    expect(formatAtomHtml(atom)).toBe('<sup>13</sup>C');
  });

  it('formats atom counts as subscript elements', () => {
    const atomCounts: AtomCount[] = [
      { symbol: 'C', mass_number: 12, isotope_was_specified: false, atom_ram: 12, count: 6, total_mass: 72 },
      { symbol: 'H', mass_number: 1, isotope_was_specified: false, atom_ram: 1, count: 12, total_mass: 12 },
      { symbol: 'O', mass_number: 16, isotope_was_specified: false, atom_ram: 16, count: 6, total_mass: 96 },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe('C<sub>6</sub>H<sub>12</sub>O<sub>6</sub>');
  });

  it('formats specified isotope mass numbers as superscript elements', () => {
    const atomCounts: AtomCount[] = [
      { symbol: 'C', mass_number: 13, isotope_was_specified: true, atom_ram: 13, count: 1, total_mass: 13 },
      { symbol: 'H', mass_number: 1, isotope_was_specified: false, atom_ram: 1, count: 4, total_mass: 4 },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe('<sup>13</sup>CH<sub>4</sub>');
  });

  it('retains input order and omits a subscript for count one', () => {
    const atomCounts: AtomCount[] = [
      { symbol: 'O', mass_number: 16, isotope_was_specified: false, atom_ram: 16, count: 1, total_mass: 16 },
      { symbol: 'N', mass_number: 14, isotope_was_specified: false, atom_ram: 14, count: 2, total_mass: 28 },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe('ON<sub>2</sub>');
  });

  it('escapes symbols before returning HTML', () => {
    const atomCounts: AtomCount[] = [
      { symbol: '<img>', mass_number: 1, isotope_was_specified: false, atom_ram: 1, count: 1, total_mass: 1 },
    ];

    expect(formatFormulaHtml(atomCounts)).toBe('&lt;img&gt;');
  });
});

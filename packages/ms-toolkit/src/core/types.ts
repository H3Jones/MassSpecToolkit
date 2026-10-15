export interface AtomCount {
  symbol: string;
  mass_number: number;
  isotope_was_specified: boolean;
  atom_ram: number;
  count: number;
  total_mass: number;
}

export interface FormulaResult {
  formula: string;
  mass: number;
  atom_counts: AtomCount[];
}

export interface IonResult extends FormulaResult {
  charge: number;
  mass_to_charge: number | null;
}

export interface MassSplitResult {
  formula_a: FormulaResult;
  formula_b: FormulaResult;
  formula_a_only: FormulaResult | null;
  formula_b_only: FormulaResult | null;
  mass_difference: number;
}

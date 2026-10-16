use ms_core::formula::Formula;
use ms_core::ion::{Charge, Ion};
use serde::Serialize;
use tsify::{Ts, Tsify};
use wasm_bindgen::JsError;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Tsify)]
pub struct FormulaResult {
    formula: String,
    mass: f64,
    dbe: f64,
    atom_counts: Vec<AtomCount>,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct IonResult {
    formula: String,
    charge: i32,
    mass: f64,
    dbe: f64,
    mass_to_charge: Option<f64>,
    atom_counts: Vec<AtomCount>,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct MassSplitResult {
    formula_a: FormulaResult,
    formula_b: FormulaResult,
    formula_a_only: Option<FormulaResult>,
    formula_b_only: Option<FormulaResult>,
    mass_difference: f64,
}

#[derive(Serialize, Tsify)]
struct AtomCount {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    atom_ram: f64,
    count: i32,
    total_mass: f64,
}

/// Parses a chemical formula and returns its normalized form, mass, and atom counts.
#[wasm_bindgen]
pub fn parse_formula(input: &str) -> Result<Ts<FormulaResult>, JsError> {
    let formula = Formula::parse(input).map_err(|error| JsError::new(&error.to_string()))?;
    let result = formula_result(&formula);

    Ok(result.into_ts()?)
}

/// Evaluates a formula with a signed charge and returns its mass and, for ions, mass-to-charge ratio.
#[wasm_bindgen]
pub fn evaluate_ion(input: &str, charge: i32) -> Result<Ts<IonResult>, JsError> {
    let charge_type = Charge::try_from(charge).map_err(JsError::new)?;
    let formula = Formula::parse(input).map_err(|error| JsError::new(&error.to_string()))?;
    let ion = Ion::new(formula, charge_type);
    let formula_result = formula_result(ion.formula());
    let result = IonResult {
        formula: formula_result.formula,
        charge,
        mass: ion.mass(),
        dbe: formula_result.dbe,
        mass_to_charge: (charge != 0).then(|| ion.mass_to_charge()),
        atom_counts: formula_result.atom_counts,
    };

    Ok(result.into_ts()?)
}

/// Compares two formulas and returns their formula-specific components and signed mass difference.
#[wasm_bindgen]
pub fn mass_split(formula_a: &str, formula_b: &str) -> Result<Ts<MassSplitResult>, JsError> {
    let formula_a = Formula::parse(formula_a).map_err(|error| JsError::new(&error.to_string()))?;
    let formula_b = Formula::parse(formula_b).map_err(|error| JsError::new(&error.to_string()))?;
    let difference = formula_a.difference(&formula_b);
    let mass_difference = match difference.mass() {
        mass if mass == 0.0 => 0.0,
        mass => mass,
    };
    let (formula_b_only, formula_a_only) = difference.as_split();
    let result = MassSplitResult {
        formula_a: formula_result(&formula_a),
        formula_b: formula_result(&formula_b),
        formula_a_only: formula_a_only.as_ref().map(formula_result),
        formula_b_only: formula_b_only.as_ref().map(formula_result),
        mass_difference,
    };

    Ok(result.into_ts()?)
}

fn formula_result(formula: &Formula) -> FormulaResult {
    FormulaResult {
        formula: formula.to_string(),
        mass: formula.mass(),
        atom_counts: formula
            .atom_counts()
            .iter()
            .map(|atom_count| AtomCount {
                symbol: atom_count.atom.symbol(),
                mass_number: atom_count.atom.mass_number(),
                isotope_was_specified: atom_count.atom.isotope_was_specified(),
                atom_ram: atom_count.atom.relative_atomic_mass(),
                count: atom_count.count,
                total_mass: atom_count.mass(),
            })
            .collect(),
        dbe: formula.dbe(),
    }
}

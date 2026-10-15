use ms_core::formula::Formula;
use ms_core::ion::{Charge, Ion};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct FormulaResult {
    formula: String,
    mass: f64,
    atom_counts: Vec<AtomCountResult>,
}

#[derive(Serialize)]
struct IonResult {
    formula: String,
    charge: i32,
    mass: f64,
    mass_to_charge: f64,
    atom_counts: Vec<AtomCountResult>,
}

#[derive(Serialize)]
struct AtomCountResult {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    atom_ram: f64,
    count: u32,
    total_mass: f64,
}

/// Parses a chemical formula and returns its normalized form, mass, and atom counts.
#[wasm_bindgen]
pub fn parse_formula(input: &str) -> Result<JsValue, JsValue> {
    let formula = Formula::parse(input).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let result = formula_result(&formula);

    serde_wasm_bindgen::to_value(&result).map_err(|error| JsValue::from_str(&error.to_string()))
}

/// Evaluates a formula with a signed charge and returns its ion mass and mass-to-charge ratio.
#[wasm_bindgen]
pub fn evaluate_ion(input: &str, charge: i32) -> Result<JsValue, JsValue> {
    let charge_type = Charge::try_from(charge).map_err(|error| JsValue::from_str(error))?;
    let formula = Formula::parse(input).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let ion = Ion::new(formula, charge_type);
    let formula_result = formula_result(ion.formula());
    let result = IonResult {
        formula: formula_result.formula,
        charge,
        mass: ion.mass(),
        mass_to_charge: ion.mass_to_charge(),
        atom_counts: formula_result.atom_counts,
    };

    serde_wasm_bindgen::to_value(&result).map_err(|error| JsValue::from_str(&error.to_string()))
}

fn formula_result(formula: &Formula) -> FormulaResult {
    FormulaResult {
        formula: formula.to_string(),
        mass: formula.mass(),
        atom_counts: formula
            .atom_counts()
            .iter()
            .map(|atom_count| AtomCountResult {
                symbol: atom_count.atom.symbol(),
                mass_number: atom_count.atom.mass_number(),
                isotope_was_specified: atom_count.atom.isotope_was_specified(),
                atom_ram: atom_count.atom.relative_atomic_mass(),
                count: atom_count.count,
                total_mass: atom_count.mass(),
            })
            .collect(),
    }
}

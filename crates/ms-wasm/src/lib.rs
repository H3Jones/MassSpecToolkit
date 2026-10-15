use ms_core::formula::Formula;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
struct FormulaResult {
    formula: String,
    mass: f64,
    atom_counts: Vec<AtomCountResult>,
}

#[derive(Serialize)]
struct AtomCountResult {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    count: u32,
    mass: f64,
}

/// Parses a chemical formula and returns its normalized form, mass, and atom counts.
#[wasm_bindgen]
pub fn parse_formula(input: &str) -> Result<JsValue, JsValue> {
    let formula = Formula::parse(input).map_err(|error| JsValue::from_str(&error.to_string()))?;
    let result = FormulaResult {
        formula: formula.to_string(),
        mass: formula.mass(),
        atom_counts: formula
            .atom_counts()
            .iter()
            .map(|atom_count| AtomCountResult {
                symbol: atom_count.atom.symbol(),
                mass_number: atom_count.atom.mass_number(),
                isotope_was_specified: atom_count.atom.isotope_was_specified(),
                count: atom_count.count,
                mass: atom_count.mass(),
            })
            .collect(),
    };

    serde_wasm_bindgen::to_value(&result)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

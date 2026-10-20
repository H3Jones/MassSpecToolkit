use ms_core::assignment::{ElementRange, MassTolerance, assign_mass};
use ms_core::formula::{Formula, sort_by_hill_order};
use ms_core::ion::{Charge, Ion};
use ms_core::isotopes::{
    FineIsotopeDistributionOptions, IsotopeDistributionError,
    fine_isotope_distribution as calculate_fine_isotope_distribution, isotope_data,
};
use ms_core::parser::parse_element_ranges as parse_ranges;
use ms_core::{ELECTRON_MASS, isotopes::IsotopeId};
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
pub struct ElementRangeResult {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    min: i32,
    max: i32,
}

#[derive(Serialize, Tsify)]
pub struct ElementRangesResult {
    ranges: Vec<ElementRangeResult>,
}

#[derive(Clone, Copy, Serialize, Tsify)]
#[serde(rename_all = "lowercase")]
pub enum MassToleranceUnit {
    Ppm,
    Da,
}

#[derive(Serialize, Tsify)]
pub struct PeakAssignmentMatchResult {
    formula: String,
    charge: i32,
    mass: f64,
    mass_to_charge: f64,
    error_da: f64,
    error_ppm: f64,
}

#[derive(Serialize, Tsify)]
pub struct PeakAssignmentResult {
    observed_mz: f64,
    tolerance: f64,
    tolerance_unit: MassToleranceUnit,
    charges: Vec<i32>,
    element_ranges: Vec<ElementRangeResult>,
    matches: Vec<PeakAssignmentMatchResult>,
}

#[derive(Serialize, Tsify)]
pub struct FineIsotopePeakResult {
    label: String,
    mass: f64,
    mass_to_charge: Option<f64>,
    abundance: f64,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct FineIsotopeDistributionResult {
    charge: i32,
    retained_probability: f64,
    peaks: Vec<FineIsotopePeakResult>,
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

/// Parses a comma- or whitespace-separated range list for display before assignment.
#[wasm_bindgen]
pub fn parse_element_ranges(input: &str) -> Result<Ts<ElementRangesResult>, JsError> {
    let ranges = parse_ranges(input).map_err(|error| JsError::new(&error.to_string()))?;
    let result = ElementRangesResult {
        ranges: ranges.iter().map(element_range_result).collect(),
    };
    Ok(result.into_ts()?)
}

/// Assigns one measured m/z over an inclusive signed charge range, excluding zero.
/// Formulas describe the complete ion composition; no adducts are added.
#[wasm_bindgen]
pub fn assign_peak(
    observed_mz: f64,
    tolerance: f64,
    tolerance_unit: &str,
    charge_min: f64,
    charge_max: f64,
    element_ranges: &str,
) -> Result<Ts<PeakAssignmentResult>, JsError> {
    for charge in [charge_min, charge_max] {
        if !charge.is_finite() || charge.fract() != 0.0 || !(-255.0..=255.0).contains(&charge) {
            return Err(JsError::new(
                "charge bounds must be integers between -255 and 255",
            ));
        }
    }
    if charge_min > charge_max {
        return Err(JsError::new(
            "minimum charge must not exceed maximum charge",
        ));
    }
    let charges: Vec<_> = (charge_min as i32..=charge_max as i32)
        .filter(|charge| *charge != 0)
        .collect();
    if charges.is_empty() {
        return Err(JsError::new(
            "charge range must include at least one nonzero charge",
        ));
    }
    let (mass_tolerance, tolerance_unit) = match tolerance_unit {
        "ppm" => (MassTolerance::Ppm(tolerance), MassToleranceUnit::Ppm),
        "da" => (MassTolerance::Da(tolerance), MassToleranceUnit::Da),
        _ => return Err(JsError::new("tolerance unit must be ppm or da")),
    };
    let ranges = parse_ranges(element_ranges).map_err(|error| JsError::new(&error.to_string()))?;
    let mut matches = Vec::new();
    for &charge in &charges {
        let charge_type = Charge::try_from(charge).map_err(JsError::new)?;
        let assignments = assign_mass(observed_mz, charge_type, &ranges, mass_tolerance)
            .map_err(|error| JsError::new(&error.to_string()))?;
        matches.extend(
            assignments
                .into_iter()
                .map(|hit| PeakAssignmentMatchResult {
                    formula: hit.ion.formula().to_string(),
                    charge,
                    mass: hit.ion.mass(),
                    mass_to_charge: hit.ion.mass_to_charge(),
                    error_da: hit.error_da,
                    error_ppm: hit.error_ppm,
                }),
        );
    }
    matches.sort_by(|a, b| {
        a.error_da
            .abs()
            .total_cmp(&b.error_da.abs())
            .then_with(|| a.formula.cmp(&b.formula))
            .then_with(|| a.charge.cmp(&b.charge))
    });
    let result = PeakAssignmentResult {
        observed_mz,
        tolerance,
        tolerance_unit,
        charges,
        element_ranges: ranges.iter().map(element_range_result).collect(),
        matches,
    };
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

/// Calculates a fine-structure isotope distribution and applies electron-mass correction for charge.
#[wasm_bindgen]
pub fn fine_isotope_distribution(
    input: &str,
    charge: i32,
) -> Result<Ts<FineIsotopeDistributionResult>, JsError> {
    Charge::try_from(charge).map_err(JsError::new)?;
    let formula = Formula::parse(input).map_err(|error| JsError::new(&error.to_string()))?;
    let mut distribution = None;
    let mut state_limit_error = None;
    for coverage in [1.0, 0.9999, 0.999, 0.99] {
        match calculate_fine_isotope_distribution(
            &formula,
            FineIsotopeDistributionOptions {
                coverage,
                ..FineIsotopeDistributionOptions::default()
            },
        ) {
            Ok(result) => {
                distribution = Some(result);
                break;
            }
            Err(error @ IsotopeDistributionError::StateLimitExceeded { .. }) => {
                state_limit_error = Some(error);
            }
            Err(error) => return Err(JsError::new(&error.to_string())),
        }
    }
    let distribution = match (distribution, state_limit_error) {
        (Some(result), _) => result,
        (None, Some(error)) => return Err(JsError::new(&error.to_string())),
        (None, None) => return Err(JsError::new("no isotope coverage targets configured")),
    };
    let peaks = distribution
        .peaks
        .into_iter()
        .map(|mut peak| {
            sort_by_hill_order(&mut peak.composition);
            let label = peak
                .composition
                .iter()
                .map(|entry| {
                    let isotope = isotope_data(IsotopeId {
                        atomic_number: entry.isotope.atomic_number,
                        mass_number: entry.isotope.mass_number,
                    })
                    .expect("isotope compositions only contain known isotope ids");
                    if entry.count == 1 {
                        isotope.isotope_symbol()
                    } else {
                        format!("{}{}", isotope.isotope_symbol(), entry.count)
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let mass = peak.mass - f64::from(charge) * ELECTRON_MASS;
            FineIsotopePeakResult {
                label,
                mass,
                mass_to_charge: (charge != 0).then(|| mass / f64::from(charge.unsigned_abs())),
                abundance: peak.abundance,
            }
        })
        .collect();
    let result = FineIsotopeDistributionResult {
        charge,
        retained_probability: distribution.retained_probability,
        peaks,
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

fn element_range_result(range: &ElementRange) -> ElementRangeResult {
    ElementRangeResult {
        symbol: range.symbol(),
        mass_number: range.atom().mass_number(),
        isotope_was_specified: range.atom().isotope_was_specified(),
        min: range.min(),
        max: range.max(),
    }
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

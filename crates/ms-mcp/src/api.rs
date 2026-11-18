use ms_core::assignment::{MassTolerance, assign_mass};
use ms_core::formula::{AtomCount, Formula, sort_by_hill_order};
use ms_core::ion::{Charge, Ion};
use ms_core::isotopes::{
    FineIsotopeDistributionOptions,
    fine_isotope_distribution as calculate_fine_isotope_distribution, isotope_data,
};
use ms_core::parser::parse_element_ranges;
use ms_core::{ELECTRON_MASS, isotopes::IsotopeId};
use serde::Serialize;

const MAX_FORMULA_LENGTH: usize = 2_048;
const MAX_FORMULA_ATOMS: u64 = 300;
const MAX_ISOTOPE_STATES: usize = 20_000;
const MAX_RANGE_INPUT_LENGTH: usize = 1_000;
const MAX_ELEMENT_RANGES: usize = 12;
const MAX_ASSIGNMENT_SEARCH_SPACE: u64 = 100_000;
const MAX_ASSIGNMENT_MATCHES: usize = 1_000;

#[derive(Clone, Copy)]
pub(crate) enum ToleranceUnit {
    Ppm,
    Da,
}

#[derive(Serialize)]
pub(crate) struct AtomCountResult {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    atom_ram: f64,
    count: i32,
    total_mass: f64,
}

#[derive(Serialize)]
pub(crate) struct FormulaResult {
    formula: String,
    mass: f64,
    dbe: f64,
    atom_counts: Vec<AtomCountResult>,
}

#[derive(Serialize)]
pub(crate) struct IonResult {
    formula: String,
    charge: i32,
    mass: f64,
    dbe: f64,
    mass_to_charge: Option<f64>,
    atom_counts: Vec<AtomCountResult>,
}

#[derive(Serialize)]
pub(crate) struct MassSplitResult {
    formula_a: FormulaResult,
    formula_b: FormulaResult,
    formula_a_only: Option<FormulaResult>,
    formula_b_only: Option<FormulaResult>,
    mass_difference: f64,
}

#[derive(Serialize)]
pub(crate) struct PeakAssignmentMatchResult {
    formula: String,
    charge: i32,
    mass: f64,
    mass_to_charge: f64,
    error_da: f64,
    error_ppm: f64,
}

#[derive(Serialize)]
pub(crate) struct PeakAssignmentResult {
    observed_mz: f64,
    tolerance: f64,
    tolerance_unit: &'static str,
    charge: i32,
    element_ranges: String,
    matches: Vec<PeakAssignmentMatchResult>,
}

#[derive(Serialize)]
pub(crate) struct FineIsotopePeakResult {
    label: String,
    mass: f64,
    mass_to_charge: Option<f64>,
    abundance: f64,
}

#[derive(Serialize)]
pub(crate) struct FineIsotopeDistributionResult {
    charge: i32,
    retained_probability: f64,
    peaks: Vec<FineIsotopePeakResult>,
}

pub(crate) fn evaluate_ion(input: &str, charge: i32) -> Result<IonResult, String> {
    let formula = parse_bounded_formula(input)?;
    let charge_type = Charge::try_from(charge).map_err(str::to_owned)?;
    let ion = Ion::new(formula, charge_type);
    let formula = formula_result(ion.formula());
    Ok(IonResult {
        formula: formula.formula,
        charge,
        mass: ion.mass(),
        dbe: formula.dbe,
        mass_to_charge: (charge != 0).then(|| ion.mass_to_charge()),
        atom_counts: formula.atom_counts,
    })
}

pub(crate) fn mass_split(formula_a: &str, formula_b: &str) -> Result<MassSplitResult, String> {
    let formula_a = parse_bounded_formula(formula_a)?;
    let formula_b = parse_bounded_formula(formula_b)?;
    let difference = formula_a.difference(&formula_b);
    let mass_difference = difference.mass();
    let (formula_b_only, formula_a_only) = difference.as_split();
    Ok(MassSplitResult {
        formula_a: formula_result(&formula_a),
        formula_b: formula_result(&formula_b),
        formula_a_only: formula_a_only.as_ref().map(formula_result),
        formula_b_only: formula_b_only.as_ref().map(formula_result),
        mass_difference,
    })
}

pub(crate) fn assign_peak(
    observed_mz: f64,
    tolerance_value: f64,
    tolerance_unit: ToleranceUnit,
    charge_value: i32,
    element_ranges: &str,
) -> Result<PeakAssignmentResult, String> {
    if element_ranges.len() > MAX_RANGE_INPUT_LENGTH {
        return Err(format!(
            "element range input exceeds {MAX_RANGE_INPUT_LENGTH} characters"
        ));
    }

    let ranges = parse_element_ranges(element_ranges).map_err(|error| error.to_string())?;
    if ranges.len() > MAX_ELEMENT_RANGES {
        return Err(format!(
            "at most {MAX_ELEMENT_RANGES} element ranges are supported"
        ));
    }

    let mut search_space = 1_u64;
    for range in &ranges {
        let count = u64::try_from(i64::from(range.max()) - i64::from(range.min()) + 1)
            .map_err(|_| "invalid element range".to_owned())?;
        search_space = search_space
            .checked_mul(count)
            .ok_or_else(|| "element range search space is too large".to_owned())?;
        if search_space > MAX_ASSIGNMENT_SEARCH_SPACE {
            return Err(format!(
                "element ranges exceed the {MAX_ASSIGNMENT_SEARCH_SPACE}-combination search limit"
            ));
        }
    }

    let charge = Charge::try_from(charge_value).map_err(str::to_owned)?;
    let (tolerance, tolerance_unit_name) = match tolerance_unit {
        ToleranceUnit::Ppm => (MassTolerance::Ppm(tolerance_value), "ppm"),
        ToleranceUnit::Da => (MassTolerance::Da(tolerance_value), "da"),
    };
    let matches =
        assign_mass(observed_mz, charge, &ranges, tolerance).map_err(|error| error.to_string())?;
    if matches.len() > MAX_ASSIGNMENT_MATCHES {
        return Err(format!(
            "assignment produced more than {MAX_ASSIGNMENT_MATCHES} matches; narrow the tolerance or element ranges"
        ));
    }

    let matches = matches
        .into_iter()
        .map(|hit| PeakAssignmentMatchResult {
            formula: hit.ion().formula().to_string(),
            charge: charge_value,
            mass: hit.ion().mass(),
            mass_to_charge: hit.calculated_mz(),
            error_da: hit.error_da(),
            error_ppm: hit.error_ppm(),
        })
        .collect();
    Ok(PeakAssignmentResult {
        observed_mz,
        tolerance: tolerance_value,
        tolerance_unit: tolerance_unit_name,
        charge: charge_value,
        element_ranges: element_ranges.to_owned(),
        matches,
    })
}

pub(crate) fn fine_isotope_distribution(
    formula_input: &str,
    charge_value: i32,
    coverage: f64,
) -> Result<FineIsotopeDistributionResult, String> {
    let formula = parse_bounded_formula(formula_input)?;
    Charge::try_from(charge_value).map_err(str::to_owned)?;
    let distribution = calculate_fine_isotope_distribution(
        &formula,
        FineIsotopeDistributionOptions {
            coverage,
            max_states: MAX_ISOTOPE_STATES,
        },
    )
    .map_err(|error| error.to_string())?;
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
                    .ok_or_else(|| "isotope composition contained an unknown isotope".to_owned())?;
                    Ok(if entry.count == 1 {
                        isotope.isotope_symbol()
                    } else {
                        format!("{}{}", isotope.isotope_symbol(), entry.count)
                    })
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(" ");
            let mass = peak.mass - f64::from(charge_value) * ELECTRON_MASS;
            Ok(FineIsotopePeakResult {
                label,
                mass,
                mass_to_charge: (charge_value != 0)
                    .then(|| mass / f64::from(charge_value.unsigned_abs())),
                abundance: peak.abundance,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(FineIsotopeDistributionResult {
        charge: charge_value,
        retained_probability: distribution.retained_probability,
        peaks,
    })
}

fn parse_bounded_formula(input: &str) -> Result<Formula, String> {
    if input.len() > MAX_FORMULA_LENGTH {
        return Err(format!(
            "formula exceeds the {MAX_FORMULA_LENGTH}-character input limit"
        ));
    }
    let formula = Formula::parse(input).map_err(|error| error.to_string())?;
    let atom_count = formula
        .atom_counts()
        .iter()
        .try_fold(0_u64, |total, atom_count| {
            total.checked_add(u64::from(atom_count.count.unsigned_abs()))
        })
        .ok_or_else(|| "formula atom count overflowed".to_owned())?;
    if atom_count > MAX_FORMULA_ATOMS {
        return Err(format!(
            "formula exceeds the {MAX_FORMULA_ATOMS}-atom calculation limit"
        ));
    }
    Ok(formula)
}

fn formula_result(formula: &Formula) -> FormulaResult {
    FormulaResult {
        formula: formula.to_string(),
        mass: formula.mass(),
        dbe: formula.dbe(),
        atom_counts: formula
            .atom_counts()
            .iter()
            .map(atom_count_result)
            .collect(),
    }
}

fn atom_count_result(atom_count: &AtomCount) -> AtomCountResult {
    AtomCountResult {
        symbol: atom_count.atom.symbol(),
        mass_number: atom_count.atom.mass_number(),
        isotope_was_specified: atom_count.atom.isotope_was_specified(),
        atom_ram: atom_count.atom.relative_atomic_mass(),
        count: atom_count.count,
        total_mass: atom_count.mass(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_ion_and_reports_signed_charge() {
        let result = evaluate_ion("H2O", 1).unwrap();
        assert_eq!(result.formula, "H2O");
        assert_eq!(result.charge, 1);
        assert_eq!(result.mass_to_charge, Some(result.mass));
    }

    #[test]
    fn mass_split_keeps_formula_specific_sides_and_signed_difference() {
        let result = mass_split("C2H6O", "CH2O").unwrap();
        assert_eq!(result.formula_a_only.as_ref().unwrap().formula, "CH4");
        assert!(result.formula_b_only.is_none());
        assert!(result.mass_difference > 0.0);
    }

    #[test]
    fn peak_assignment_finds_matching_formula() {
        let result = assign_peak(
            180.06338810418,
            5.0,
            ToleranceUnit::Ppm,
            0,
            "C4-8,H8-16,O2-8",
        )
        .unwrap();
        assert!(
            result.matches.iter().any(|hit| hit.formula == "C6H12O6"),
            "unexpected assignment formulas: {:?}",
            result
                .matches
                .iter()
                .map(|hit| hit.formula.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(result.tolerance_unit, "ppm");
    }

    #[test]
    fn isotope_distribution_honors_coverage_and_charge() {
        let result = fine_isotope_distribution("C2H6O", 1, 0.999).unwrap();
        assert!(result.retained_probability >= 0.999 - 1e-12);
        assert!(
            result
                .peaks
                .iter()
                .all(|peak| peak.mass_to_charge.is_some())
        );
    }

    #[test]
    fn rejects_unbounded_peak_assignment_ranges_and_oversized_formulas() {
        assert!(matches!(
            assign_peak(100.0, 5.0, ToleranceUnit::Ppm, 1, "C0-2147483647"),
            Err(error) if error.contains("search limit")
        ));

        let error = parse_bounded_formula("C301").unwrap_err();
        assert!(error.contains("300-atom"));
    }

    #[test]
    fn returns_invalid_formula_and_charge_errors_to_the_caller() {
        assert!(evaluate_ion("not-a-formula", 1).is_err());
        assert!(evaluate_ion("H2O", 256).is_err());
    }
}

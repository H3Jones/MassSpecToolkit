use ms_core::ELECTRON_MASS;
use ms_core::formula::{Formula, sort_by_hill_order};
use ms_core::ion::{Charge, Ion};
use ms_core::isotopes::{
    FineIsotopeDistributionOptions, IsotopeDistributionError,
    fine_isotope_distribution as calculate_fine_isotope_distribution, isotope_data,
};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;

#[derive(Clone)]
#[pyclass(frozen, get_all, module = "ms_py")]
struct AtomCount {
    symbol: String,
    mass_number: u16,
    isotope_was_specified: bool,
    atom_ram: f64,
    count: i32,
    total_mass: f64,
}

#[derive(Clone)]
#[pyclass(frozen, get_all, module = "ms_py")]
struct FormulaResult {
    formula: String,
    mass: f64,
    dbe: f64,
    atom_counts: Vec<AtomCount>,
}

#[derive(Clone)]
#[pyclass(frozen, get_all, module = "ms_py")]
struct IonResult {
    formula: String,
    charge: i32,
    mass: f64,
    dbe: f64,
    mass_to_charge: Option<f64>,
    atom_counts: Vec<AtomCount>,
}

#[pyclass(frozen, get_all, module = "ms_py")]
struct MassSplitResult {
    formula_a: FormulaResult,
    formula_b: FormulaResult,
    formula_a_only: Option<FormulaResult>,
    formula_b_only: Option<FormulaResult>,
    mass_difference: f64,
}

#[derive(Clone)]
#[pyclass(frozen, get_all, module = "ms_py")]
struct FineIsotopePeakResult {
    label: String,
    mass: f64,
    mass_to_charge: Option<f64>,
    abundance: f64,
}

#[pyclass(frozen, get_all, module = "ms_py")]
struct FineIsotopeDistributionResult {
    charge: i32,
    retained_probability: f64,
    peaks: Vec<FineIsotopePeakResult>,
}

fn formula_result(formula: &Formula) -> FormulaResult {
    FormulaResult {
        formula: formula.to_string(),
        mass: formula.mass(),
        dbe: formula.dbe(),
        atom_counts: formula
            .atom_counts()
            .iter()
            .map(|entry| AtomCount {
                symbol: entry.atom.symbol().to_owned(),
                mass_number: entry.atom.mass_number(),
                isotope_was_specified: entry.atom.isotope_was_specified(),
                atom_ram: entry.atom.relative_atomic_mass(),
                count: entry.count,
                total_mass: entry.mass(),
            })
            .collect(),
    }
}

fn parse(input: &str) -> PyResult<Formula> {
    Formula::parse(input).map_err(|error| PyValueError::new_err(error.to_string()))
}

/// Parse a chemical formula into its core representation, mass, DBE, and atom counts.
#[pyfunction]
fn parse_formula(input: &str) -> PyResult<FormulaResult> {
    Ok(formula_result(&parse(input)?))
}

/// Evaluate a signed charge, including electron-mass correction.
#[pyfunction(signature = (input, charge=0))]
fn evaluate_ion(input: &str, charge: i32) -> PyResult<IonResult> {
    let charge_type = Charge::try_from(charge).map_err(PyValueError::new_err)?;
    let ion = Ion::new(parse(input)?, charge_type);
    let result = formula_result(ion.formula());
    Ok(IonResult {
        formula: result.formula,
        charge,
        mass: ion.mass(),
        dbe: result.dbe,
        mass_to_charge: (charge != 0).then(|| ion.mass_to_charge()),
        atom_counts: result.atom_counts,
    })
}

/// Compare formulas. The signed mass difference is formula_a minus formula_b.
#[pyfunction]
fn mass_split(formula_a: &str, formula_b: &str) -> PyResult<MassSplitResult> {
    let formula_a = parse(formula_a)?;
    let formula_b = parse(formula_b)?;
    let difference = formula_a.difference(&formula_b);
    let mass = difference.mass();
    let mass_difference = if mass == 0.0 { 0.0 } else { mass };
    let (formula_b_only, formula_a_only) = difference.as_split();
    Ok(MassSplitResult {
        formula_a: formula_result(&formula_a),
        formula_b: formula_result(&formula_b),
        formula_a_only: formula_a_only.as_ref().map(formula_result),
        formula_b_only: formula_b_only.as_ref().map(formula_result),
        mass_difference,
    })
}

fn distribution_error(error: IsotopeDistributionError) -> PyErr {
    match error {
        IsotopeDistributionError::InvalidCoverage
        | IsotopeDistributionError::InvalidMaxStates
        | IsotopeDistributionError::ElementHasNoAbundanceData(_) => {
            PyValueError::new_err(error.to_string())
        }
        _ => PyRuntimeError::new_err(error.to_string()),
    }
}

/// Calculate fine isotope peaks without silently reducing the requested coverage.
///
/// Abundances are absolute probabilities, not renormalized after pruning.
#[pyfunction(signature = (input, charge=0, *, coverage=0.9999, max_states=200_000))]
fn fine_isotope_distribution(
    py: Python<'_>,
    input: &str,
    charge: i32,
    coverage: f64,
    max_states: usize,
) -> PyResult<FineIsotopeDistributionResult> {
    Charge::try_from(charge).map_err(PyValueError::new_err)?;
    let formula = parse(input)?;
    let distribution = py
        .detach(|| {
            calculate_fine_isotope_distribution(
                &formula,
                FineIsotopeDistributionOptions::new(coverage, max_states),
            )
        })
        .map_err(distribution_error)?;
    let peaks = distribution
        .peaks
        .into_iter()
        .map(|mut peak| {
            sort_by_hill_order(&mut peak.composition);
            let label = peak
                .composition
                .iter()
                .map(|entry| {
                    let isotope = isotope_data(entry.isotope)
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
    Ok(FineIsotopeDistributionResult {
        charge,
        retained_probability: distribution.retained_probability,
        peaks,
    })
}

#[pymodule]
fn ms_py(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<AtomCount>()?;
    module.add_class::<FormulaResult>()?;
    module.add_class::<IonResult>()?;
    module.add_class::<MassSplitResult>()?;
    module.add_class::<FineIsotopePeakResult>()?;
    module.add_class::<FineIsotopeDistributionResult>()?;
    module.add_function(wrap_pyfunction!(parse_formula, module)?)?;
    module.add_function(wrap_pyfunction!(evaluate_ion, module)?)?;
    module.add_function(wrap_pyfunction!(mass_split, module)?)?;
    module.add_function(wrap_pyfunction!(fine_isotope_distribution, module)?)?;
    module.add("ELECTRON_MASS", ELECTRON_MASS)?;
    module.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}

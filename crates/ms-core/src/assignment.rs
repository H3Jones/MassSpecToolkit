//! Exact-mass formula assignment for one discrete peak.

use crate::{
    ELECTRON_MASS,
    formula::{Atom, AtomCount, Formula, sort_by_hill_order},
    ion::{Charge, Ion},
    isotopes::{atomic_number_for_symbol, most_abundant_isotope},
    parser::{self, ElementRangeParseError},
};

/// Inclusive atom-count bounds for one element, using its most-abundant isotope.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ElementRange {
    atom: Atom,
    min: i32,
    max: i32,
}

impl ElementRange {
    /// Creates a range with nonnegative counts and `min <= max`.
    pub fn new(symbol: &str, min: i32, max: i32) -> Result<Self, ElementRangeParseError> {
        if min < 0 || max < min {
            return Err(ElementRangeParseError::InvalidRange {
                symbol: symbol.to_owned(),
                min,
                max,
            });
        }
        if atomic_number_for_symbol(symbol).is_none() {
            return Err(ElementRangeParseError::UnknownElement(symbol.to_owned()));
        }
        let isotope = most_abundant_isotope(symbol)
            .ok_or_else(|| ElementRangeParseError::NoMostAbundantIsotope(symbol.to_owned()))?;
        Ok(Self {
            atom: Atom::from_isotope_id(isotope, false),
            min,
            max,
        })
    }

    /// Parses inclusive bounds such as `C4-100` or a fixed count such as `Na1`.
    /// Surrounding whitespace is ignored; isotope labels and groups are not accepted.
    pub fn parse(input: &str) -> Result<Self, ElementRangeParseError> {
        parser::parse_element_range(input)
    }

    pub fn symbol(&self) -> &'static str {
        self.atom.symbol()
    }

    pub fn min(&self) -> i32 {
        self.min
    }

    pub fn max(&self) -> i32 {
        self.max
    }
}

/// Symmetric tolerance around the observed peak, including the boundary.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MassTolerance {
    /// Absolute tolerance in the same coordinate as the input (Da for a neutral mass).
    Da(f64),
    /// Parts per million of the observed m/z, not the candidate m/z.
    Ppm(f64),
}

impl MassTolerance {
    fn absolute(self, observed_mz: f64) -> Result<f64, MassAssignmentError> {
        let value = match self {
            Self::Da(value) | Self::Ppm(value) => value,
        };
        if !value.is_finite() || value < 0.0 {
            return Err(MassAssignmentError::InvalidTolerance);
        }
        let absolute = match self {
            Self::Da(value) => value,
            Self::Ppm(value) => observed_mz * (value / 1e6),
        };
        if !absolute.is_finite() {
            return Err(MassAssignmentError::MassWindowOverflow);
        }
        Ok(absolute)
    }
}

#[derive(Clone, Debug)]
pub struct MassAssignment {
    /// Complete ion composition; charge and calculated m/z are available on the ion.
    pub ion: Ion,
    /// Calculated minus observed m/z (Da for a neutral mass).
    pub error_da: f64,
    /// `error_da / observed_mz * 1e6`.
    pub error_ppm: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MassAssignmentError {
    InvalidObservedMz,
    InvalidTolerance,
    InvalidCharge,
    EmptyElementRanges,
    DuplicateElement(&'static str),
    MassWindowOverflow,
}

impl std::fmt::Display for MassAssignmentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidObservedMz => {
                write!(f, "observed m/z must be finite and greater than zero")
            }
            Self::InvalidTolerance => write!(f, "mass tolerance must be finite and nonnegative"),
            Self::InvalidCharge => {
                write!(f, "use Charge::Neutral instead of a zero-magnitude charge")
            }
            Self::EmptyElementRanges => write!(f, "at least one element range is required"),
            Self::DuplicateElement(symbol) => write!(f, "element {symbol} has more than one range"),
            Self::MassWindowOverflow => write!(
                f,
                "mass tolerance or charge produces a nonfinite mass window"
            ),
        }
    }
}

impl std::error::Error for MassAssignmentError {}

/// Assigns formulas to one observed m/z (or a neutral mass with `Charge::Neutral`).
///
/// Formulas describe the complete ion composition: no protons or other adducts
/// are added automatically. Uses the same most-abundant isotopes and electron
/// correction as [`Formula::mass`] and [`Ion::mass_to_charge`].
///
/// All matches are returned, sorted by absolute error, then formula text for ties.
/// Missing elements are forbidden, zero counts are omitted, and an empty formula
/// is never returned. No DBE, valence, nitrogen-rule, or rule-of-13 filter is applied.
///
/// Exact-mass branch-and-bound skips impossible count combinations and directly
/// bounds the last element's count. There is no result cap or silent truncation;
/// runtime and memory can grow substantially for many wide element ranges.
///
/// ```
/// use ms_core::{
///     assignment::{ElementRange, MassTolerance, assign_mass},
///     ion::Charge,
/// };
///
/// let ranges = ["C4-100", "H8-100", "O2-100"]
///     .map(|range| ElementRange::parse(range).unwrap());
/// let matches = assign_mass(180.06338810418, Charge::Neutral, &ranges, MassTolerance::Ppm(5.0))?;
/// assert!(matches.iter().any(|hit| hit.ion.formula().to_string() == "C6H12O6"));
/// # Ok::<(), ms_core::assignment::MassAssignmentError>(())
/// ```
pub fn assign_mass(
    observed_mz: f64,
    charge: Charge,
    ranges: &[ElementRange],
    tolerance: MassTolerance,
) -> Result<Vec<MassAssignment>, MassAssignmentError> {
    if !observed_mz.is_finite() || observed_mz <= 0.0 {
        return Err(MassAssignmentError::InvalidObservedMz);
    }
    let tolerance_da = tolerance.absolute(observed_mz)?;
    let (factor, electron_correction) = match charge {
        Charge::Positive(0) | Charge::Negative(0) => {
            return Err(MassAssignmentError::InvalidCharge);
        }
        Charge::Positive(z) => (f64::from(z), f64::from(z) * ELECTRON_MASS),
        Charge::Negative(z) => (f64::from(z), -f64::from(z) * ELECTRON_MASS),
        Charge::Neutral => (1.0, 0.0),
    };
    if ranges.is_empty() {
        return Err(MassAssignmentError::EmptyElementRanges);
    }
    let mut seen = std::collections::BTreeSet::new();
    for range in ranges {
        if !seen.insert(range.atom.atomic_number()) {
            return Err(MassAssignmentError::DuplicateElement(range.symbol()));
        }
    }

    let lower = ((observed_mz - tolerance_da) * factor + electron_correction).max(0.0);
    let upper = (observed_mz + tolerance_da) * factor + electron_correction;
    if !lower.is_finite() || !upper.is_finite() {
        return Err(MassAssignmentError::MassWindowOverflow);
    }

    let mut ranges = ranges.to_vec();
    ranges.sort_by(|a, b| {
        b.atom
            .relative_atomic_mass()
            .total_cmp(&a.atom.relative_atomic_mass())
    });
    let mut suffix_min = vec![0.0; ranges.len() + 1];
    let mut suffix_max = vec![0.0; ranges.len() + 1];
    for (index, range) in ranges.iter().enumerate().rev() {
        let mass = range.atom.relative_atomic_mass();
        suffix_min[index] = suffix_min[index + 1] + mass * f64::from(range.min);
        suffix_max[index] = suffix_max[index + 1] + mass * f64::from(range.max);
    }

    // Inverting m/z and summing in a different order can round at exact boundaries.
    // Widen only pruning bounds; the final Ion m/z must satisfy the actual tolerance.
    let padding = upper.abs().max(1.0) * f64::EPSILON * (4.0 * ranges.len() as f64 + 8.0);
    let mut search = Search {
        ranges,
        suffix_min,
        suffix_max,
        lower: lower - padding,
        upper: upper + padding,
        observed_mz,
        tolerance_da,
        charge,
        matches: Vec::new(),
    };
    search.visit(0, 0.0, &mut Vec::new());
    search.matches.sort_by(|a, b| {
        a.error_da.abs().total_cmp(&b.error_da.abs()).then_with(|| {
            a.ion
                .formula()
                .to_string()
                .cmp(&b.ion.formula().to_string())
        })
    });
    Ok(search.matches)
}

struct Search {
    ranges: Vec<ElementRange>,
    suffix_min: Vec<f64>,
    suffix_max: Vec<f64>,
    lower: f64,
    upper: f64,
    observed_mz: f64,
    tolerance_da: f64,
    charge: Charge,
    matches: Vec<MassAssignment>,
}

impl Search {
    fn visit(&mut self, index: usize, mass: f64, composition: &mut Vec<AtomCount>) {
        if index == self.ranges.len() {
            if composition.is_empty() {
                return;
            }
            let mut atom_counts = composition.clone();
            sort_by_hill_order(&mut atom_counts);
            let formula = Formula::from_atom_counts(atom_counts)
                .expect("nonempty assignment compositions contain only positive counts");
            let ion = Ion::new(formula, self.charge);
            let error_da = ion.mass_to_charge() - self.observed_mz;
            if error_da.abs() <= self.tolerance_da {
                self.matches.push(MassAssignment {
                    ion,
                    error_da,
                    error_ppm: (error_da / self.observed_mz) * 1e6,
                });
            }
            return;
        }

        let range = self.ranges[index];
        let atom_mass = range.atom.relative_atomic_mass();
        let min = ((self.lower - mass - self.suffix_max[index + 1]) / atom_mass)
            .ceil()
            .max(f64::from(range.min));
        let max = ((self.upper - mass - self.suffix_min[index + 1]) / atom_mass)
            .floor()
            .min(f64::from(range.max));
        if min > max {
            return;
        }
        for count in min as i32..=max as i32 {
            if count > 0 {
                composition.push(AtomCount {
                    atom: range.atom,
                    count,
                });
            }
            self.visit(index + 1, mass + atom_mass * f64::from(count), composition);
            if count > 0 {
                composition.pop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::H2O_MASS;

    fn ranges(values: &[&str]) -> Vec<ElementRange> {
        values
            .iter()
            .map(|value| ElementRange::parse(value).unwrap())
            .collect()
    }

    fn formulas(matches: &[MassAssignment]) -> Vec<String> {
        matches
            .iter()
            .map(|hit| hit.ion.formula().to_string())
            .collect()
    }

    #[test]
    fn validates_element_range_bounds() {
        assert_eq!(ElementRange::new("H", 0, 0).unwrap().max(), 0);
        assert!(matches!(
            ElementRange::new("C", -1, 10),
            Err(ElementRangeParseError::InvalidRange { .. })
        ));
        assert!(matches!(
            ElementRange::new("C", 4, 2),
            Err(ElementRangeParseError::InvalidRange { .. })
        ));
    }

    #[test]
    fn enforces_fixed_counts_in_assignment() {
        let bounds = ranges(&["C1-3", "H0-8", "O1", "Na1", "Cl0"]);
        let expected_formula = Formula::parse("C2H4NaO").unwrap();
        for charge in [Charge::Neutral, Charge::Positive(1)] {
            let expected = Ion::new(expected_formula.clone(), charge);
            let matches = assign_mass(
                expected.mass_to_charge(),
                charge,
                &bounds,
                MassTolerance::Da(0.0),
            )
            .unwrap();
            assert_eq!(formulas(&matches), ["C2H4NaO"]);
        }
        assert!(
            assign_mass(
                Formula::parse("C2H4Na2O").unwrap().mass(),
                Charge::Neutral,
                &bounds,
                MassTolerance::Da(0.0),
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn uses_most_abundant_isotopes_without_enumerating_other_isotopes() {
        let bounds = ranges(&["Cl1"]);
        let chlorine = Formula::parse("Cl").unwrap();
        let matches = assign_mass(
            chlorine.mass(),
            Charge::Neutral,
            &bounds,
            MassTolerance::Da(0.0),
        )
        .unwrap();
        assert_eq!(formulas(&matches), ["Cl"]);
        assert_eq!(
            matches[0].ion.formula().atom_counts()[0].atom.mass_number(),
            35
        );
        assert!(
            assign_mass(
                Formula::parse("^37Cl").unwrap().mass(),
                Charge::Neutral,
                &bounds,
                MassTolerance::Da(0.0),
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn assigns_glucose_with_the_requested_wide_ranges() {
        let matches = assign_mass(
            180.06338810418,
            Charge::Neutral,
            &ranges(&["C4-100", "H8-100", "O2-100"]),
            MassTolerance::Ppm(5.0),
        )
        .unwrap();
        assert_eq!(formulas(&matches), ["C6H12O6"]);
        assert!(matches[0].error_ppm.abs() < 1e-6);
    }

    #[test]
    fn uses_ion_charge_without_adding_adducts() {
        for charge in [
            Charge::Neutral,
            Charge::Positive(1),
            Charge::Negative(1),
            Charge::Positive(2),
            Charge::Negative(3),
            Charge::Positive(255),
        ] {
            let expected = Ion::new(Formula::parse("C2H7O").unwrap(), charge);
            let matches = assign_mass(
                expected.mass_to_charge(),
                charge,
                &ranges(&["O1-1", "H7-7", "C2-2"]),
                MassTolerance::Da(0.0),
            )
            .unwrap();
            assert_eq!(formulas(&matches), ["C2H7O"], "{charge:?}");
            assert_eq!(matches[0].ion.charge(), &charge);
            assert_eq!(matches[0].error_da, 0.0);
        }
    }

    #[test]
    fn reports_signed_errors_relative_to_the_observed_peak() {
        for offset in [-0.0001, 0.0001] {
            let observed = H2O_MASS + offset;
            let matches = assign_mass(
                observed,
                Charge::Neutral,
                &ranges(&["H2-2", "O1-1"]),
                MassTolerance::Da(0.0002),
            )
            .unwrap();
            assert_eq!(matches.len(), 1);
            assert_eq!(matches[0].error_da, H2O_MASS - observed);
            assert_eq!(
                matches[0].error_ppm,
                ((H2O_MASS - observed) / observed) * 1e6
            );
        }
    }

    #[test]
    fn includes_exact_tolerance_boundaries_but_not_the_next_smaller_tolerance() {
        let bounds = ranges(&["H2-2", "O1-1"]);
        for charge in [Charge::Neutral, Charge::Positive(2), Charge::Negative(2)] {
            let calculated = Ion::new(Formula::parse("H2O").unwrap(), charge).mass_to_charge();
            for offset in [-0.001, 0.001] {
                let observed = calculated + offset;
                let difference = (calculated - observed).abs();
                assert_eq!(
                    assign_mass(observed, charge, &bounds, MassTolerance::Da(difference))
                        .unwrap()
                        .len(),
                    1
                );
                assert!(
                    assign_mass(
                        observed,
                        charge,
                        &bounds,
                        MassTolerance::Da(difference.next_down())
                    )
                    .unwrap()
                    .is_empty()
                );
            }
        }
    }

    #[test]
    fn scales_ppm_and_absolute_tolerance_in_the_observed_coordinate() {
        let bounds = ranges(&["C2-2", "H6-6", "O1-1"]);
        let charge = Charge::Positive(2);
        let calculated = Ion::new(Formula::parse("C2H6O").unwrap(), charge).mass_to_charge();
        let observed = calculated + 0.0001;
        let absolute = observed * (5.0 / 1e6);
        let ppm_matches = assign_mass(observed, charge, &bounds, MassTolerance::Ppm(5.0)).unwrap();
        let da_matches =
            assign_mass(observed, charge, &bounds, MassTolerance::Da(absolute)).unwrap();
        assert_eq!(formulas(&ppm_matches), formulas(&da_matches));
        assert_eq!(ppm_matches.len(), 1);
        assert!(
            assign_mass(observed + 0.001, charge, &bounds, MassTolerance::Ppm(5.0))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn honors_zero_counts_missing_elements_and_non_hydrocarbon_compositions() {
        let matches = assign_mass(
            H2O_MASS,
            Charge::Neutral,
            &ranges(&["C0-100", "H2-2", "O1-1"]),
            MassTolerance::Da(0.0),
        )
        .unwrap();
        assert_eq!(formulas(&matches), ["H2O"]);
        assert!(
            assign_mass(
                H2O_MASS,
                Charge::Neutral,
                &ranges(&["C1-100", "H2-2", "O1-1"]),
                MassTolerance::Da(0.0),
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            assign_mass(
                H2O_MASS,
                Charge::Neutral,
                &ranges(&["H0-10"]),
                MassTolerance::Da(0.01),
            )
            .unwrap()
            .is_empty()
        );
        for value in ["Cl2", "Fe", "CH100"] {
            let formula = Formula::parse(value).unwrap();
            let bounds: Vec<_> = formula
                .atom_counts()
                .iter()
                .map(|ac| ElementRange::new(ac.atom.symbol(), ac.count, ac.count).unwrap())
                .collect();
            let matches = assign_mass(
                formula.mass(),
                Charge::Neutral,
                &bounds,
                MassTolerance::Da(0.0),
            )
            .unwrap();
            assert_eq!(formulas(&matches), [value]);
        }
    }

    #[test]
    fn never_returns_an_empty_formula() {
        assert!(
            assign_mass(
                1.0,
                Charge::Neutral,
                &ranges(&["C0-0", "H0-0"]),
                MassTolerance::Da(2.0),
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn handles_large_count_bounds_without_scanning_to_the_maximum() {
        let matches = assign_mass(
            H2O_MASS,
            Charge::Neutral,
            &ranges(&["C0-2147483647", "H0-2147483647", "O0-2147483647"]),
            MassTolerance::Da(0.0),
        )
        .unwrap();
        assert_eq!(formulas(&matches), ["H2O"]);
        let carbon_mass = 12.0 * f64::from(i32::MAX);
        let matches = assign_mass(
            carbon_mass,
            Charge::Neutral,
            &ranges(&["C2147483647-2147483647"]),
            MassTolerance::Da(0.0),
        )
        .unwrap();
        assert_eq!(formulas(&matches), ["C2147483647"]);
    }

    #[test]
    fn rejects_invalid_search_inputs_explicitly() {
        let bounds = ranges(&["C0-10"]);
        for observed in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(matches!(
                assign_mass(observed, Charge::Neutral, &bounds, MassTolerance::Da(0.1)),
                Err(MassAssignmentError::InvalidObservedMz)
            ));
        }
        for invalid in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for tolerance in [MassTolerance::Da(invalid), MassTolerance::Ppm(invalid)] {
                assert!(matches!(
                    assign_mass(100.0, Charge::Neutral, &bounds, tolerance),
                    Err(MassAssignmentError::InvalidTolerance)
                ));
            }
        }
        for charge in [Charge::Positive(0), Charge::Negative(0)] {
            assert!(matches!(
                assign_mass(100.0, charge, &bounds, MassTolerance::Da(1.0)),
                Err(MassAssignmentError::InvalidCharge)
            ));
        }
        assert!(matches!(
            assign_mass(100.0, Charge::Neutral, &[], MassTolerance::Da(1.0)),
            Err(MassAssignmentError::EmptyElementRanges)
        ));
        assert!(matches!(
            assign_mass(
                100.0,
                Charge::Neutral,
                &ranges(&["C0-10", "C1-2"]),
                MassTolerance::Da(1.0)
            ),
            Err(MassAssignmentError::DuplicateElement("C"))
        ));
        for (observed, charge, tolerance) in [
            (f64::MAX, Charge::Positive(2), MassTolerance::Da(0.0)),
            (f64::MAX, Charge::Neutral, MassTolerance::Da(f64::MAX)),
            (f64::MAX, Charge::Neutral, MassTolerance::Ppm(f64::MAX)),
        ] {
            assert!(matches!(
                assign_mass(observed, charge, &bounds, tolerance),
                Err(MassAssignmentError::MassWindowOverflow)
            ));
        }
    }

    #[test]
    fn matches_exhaustive_enumeration_and_is_independent_of_range_order() {
        let bounds = ranges(&["C0-4", "H0-12", "Cl0-1", "O0-3"]);
        let mut reversed = bounds.clone();
        reversed.reverse();
        let mut reference = Vec::new();
        for c in 0..=4 {
            for h in 0..=12 {
                for cl in 0..=1 {
                    for o in 0..=3 {
                        let text: String = [("C", c), ("H", h), ("Cl", cl), ("O", o)]
                            .iter()
                            .filter(|(_, count)| *count > 0)
                            .map(|(symbol, count)| format!("{symbol}{count}"))
                            .collect();
                        if !text.is_empty() {
                            reference.push(Formula::parse(&text).unwrap());
                        }
                    }
                }
            }
        }
        for charge in [Charge::Neutral, Charge::Positive(1), Charge::Negative(2)] {
            for observed in [
                1.00782503223,
                H2O_MASS,
                46.04186481295,
                78.04695019338,
                100.0,
            ] {
                for tolerance in [
                    MassTolerance::Da(0.0),
                    MassTolerance::Da(0.005),
                    MassTolerance::Da(1.1),
                    MassTolerance::Ppm(5.0),
                    MassTolerance::Ppm(100_000.0),
                ] {
                    let mut expected: Vec<_> = reference
                        .iter()
                        .filter_map(|formula| {
                            let ion = Ion::new(formula.clone(), charge);
                            let error = ion.mass_to_charge() - observed;
                            (error.abs() <= tolerance.absolute(observed).unwrap())
                                .then(|| (error, formula.to_string()))
                        })
                        .collect();
                    expected.sort_by(|a, b| {
                        a.0.abs().total_cmp(&b.0.abs()).then_with(|| a.1.cmp(&b.1))
                    });
                    let expected: Vec<_> =
                        expected.into_iter().map(|(_, formula)| formula).collect();
                    let actual = assign_mass(observed, charge, &bounds, tolerance).unwrap();
                    assert_eq!(
                        formulas(&actual),
                        expected,
                        "{observed} {charge:?} {tolerance:?}"
                    );
                    let reordered = assign_mass(observed, charge, &reversed, tolerance).unwrap();
                    assert_eq!(formulas(&actual), formulas(&reordered));
                }
            }
        }
    }
}

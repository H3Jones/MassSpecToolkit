use crate::{
    formula::{Atom, Formula},
    isotopes::{ISOTOPES, IsotopeData, IsotopeId},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct IsotopePeak {
    pub nominal_mass: u32,
    /// Abundance normalized so that all peaks sum to 1.
    pub abundance: f64,
    /// Abundance-weighted exact-mass centroid for this nominal mass.
    pub mass: f64,
}

/// Number of atoms of one isotope in a fine-structure peak.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct IsotopeCount {
    /// Isotope identity; use `isotope_data` to look up its element symbol and mass.
    pub isotope: IsotopeId,
    pub count: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FineIsotopePeak {
    pub nominal_mass: u64,
    /// Retained absolute probability, not normalized after pruning.
    pub abundance: f64,
    /// Exact neutral mass of this isotope composition, in atomic mass units.
    pub mass: f64,
    /// Complete isotope counts, including fixed labels and monoisotopic elements.
    /// Sorted by atomic number, then mass number; zero counts are omitted.
    /// Fixed and naturally occurring atoms of the same isotope share one entry.
    pub composition: Vec<IsotopeCount>,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
pub struct FineIsotopeDistributionOptions {
    /// Required total probability in (0, 1]. A value of 1 disables pruning.
    pub coverage: f64,
    /// Maximum retained states at any trellis step, not just in the output.
    /// Candidate expansion may temporarily require more states.
    pub max_states: usize,
}

impl FineIsotopeDistributionOptions {
    /// Creates a new set of options with the specified coverage and maximum states.
    pub fn new(coverage: f64, max_states: usize) -> Self {
        Self {
            coverage,
            max_states,
        }
    }

    fn validate(&self) -> Result<(), IsotopeDistributionError> {
        if !(0.0 < self.coverage && self.coverage <= 1.0) {
            return Err(IsotopeDistributionError::InvalidCoverage);
        }
        if self.max_states == 0 {
            return Err(IsotopeDistributionError::InvalidMaxStates);
        }
        Ok(())
    }
}

impl Default for FineIsotopeDistributionOptions {
    fn default() -> Self {
        Self {
            coverage: 0.9999,
            max_states: 100_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FineIsotopeDistribution {
    /// Peaks sorted by exact neutral mass; nominal-mass coincidences stay separate.
    pub peaks: Vec<FineIsotopePeak>,
    /// Sum of the returned absolute abundances, before any renormalization.
    pub retained_probability: f64,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub enum IsotopeDistributionError {
    ElementHasNoAbundanceData(&'static str),
    InvalidCoverage,
    InvalidMaxStates,
    StateLimitExceeded { max_states: usize },
    ProbabilityCoverageNotReached,
    TheoreticalIsotopologueCountOverflow,
}

impl std::fmt::Display for IsotopeDistributionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ElementHasNoAbundanceData(symbol) => {
                write!(f, "element {symbol} has no isotope abundance data")
            }
            Self::InvalidCoverage => write!(f, "coverage must be finite and in (0, 1]"),
            Self::InvalidMaxStates => write!(f, "max_states must be greater than zero"),
            Self::StateLimitExceeded { max_states } => write!(
                f,
                "cannot meet isotope probability coverage within {max_states} states; increase max_states or reduce coverage"
            ),
            Self::ProbabilityCoverageNotReached => {
                write!(
                    f,
                    "numerical probability loss prevented reaching the requested coverage"
                )
            }
            Self::TheoreticalIsotopologueCountOverflow => {
                write!(f, "theoretical isotopologue count exceeds u128::MAX")
            }
        }
    }
}

impl std::error::Error for IsotopeDistributionError {}

/// Returns the isotopes and their relative abundances for a given atom.
/// If the atom has an explicitly specified isotope, only that isotope is returned with abundance 1.0.
/// Otherwise, all naturally occurring isotopes with positive abundance are returned, normalized to sum to 1.0.
/// Returns an error if the element has no abundance data.
fn atom_isotopes(atom: Atom) -> Result<Vec<(&'static IsotopeData, f64)>, IsotopeDistributionError> {
    if atom.isotope_was_specified() {
        return Ok(vec![(atom.data(), 1.0)]);
    }

    let atomic_number = atom.atomic_number();
    let isotopes: Vec<_> = ISOTOPES
        .iter()
        .filter(|isotope| isotope.id.atomic_number == atomic_number)
        .filter_map(|isotope| {
            isotope
                .isotopic_abundance
                .filter(|abundance| *abundance > 0.0)
                .map(|abundance| (isotope, abundance))
        })
        .collect();
    let total_abundance: f64 = isotopes.iter().map(|(_, abundance)| abundance).sum();

    if total_abundance == 0.0 {
        return Err(IsotopeDistributionError::ElementHasNoAbundanceData(
            atom.symbol(),
        ));
    }

    Ok(isotopes
        .into_iter()
        .map(|(isotope, abundance)| (isotope, abundance / total_abundance))
        .collect())
}

/// Counts all possible isotope compositions without expanding the distribution.
///
/// An element with `n` atoms and `k` naturally occurring isotopes contributes
/// `binomial(n + k - 1, k - 1)` compositions. The molecular count is the product
/// of these counts. Only isotopes with positive natural abundance are included,
/// matching the distribution APIs; explicitly labeled atoms are fixed.
///
/// The counting formula follows equations (2) and (4) of the
/// [isotope-distribution paper](https://www.sciencedirect.com/science/article/pii/S1044030507004308)
/// that motivated this implementation.
///
/// This counts compositions, not positional permutations or nominal-mass bins.
/// It is useful for prescreening exhaustive expansion, but a large count does
/// not imply a pruned fine-structure calculation will exceed its state limit.
/// Returns an error if the exact count cannot fit in `u128`.
///
/// ```
/// use ms_core::formula::Formula;
/// use ms_core::isotope_distribution::theoretical_isotopologues;
///
/// let formula = Formula::parse("H2O").unwrap();
/// assert_eq!(theoretical_isotopologues(&formula).unwrap(), 9);
/// ```
pub fn theoretical_isotopologues(formula: &Formula) -> Result<u128, IsotopeDistributionError> {
    let mut total = 1_u128;
    for atom_count in formula.atom_counts() {
        let isotope_count = atom_isotopes(atom_count.atom)?.len() as u128;
        let atom_count = u128::from(atom_count.count.unsigned_abs());
        let n = atom_count + isotope_count - 1;
        let k = atom_count.min(isotope_count - 1);
        let mut element_count = 1_u128;
        for i in 1..=k {
            let numerator = n - k + i;
            let mut a = numerator;
            let mut b = i;
            while b != 0 {
                (a, b) = (b, a % b);
            }
            // Cancel before multiplying to avoid overflow when the coefficient fits.
            // After removing the GCD, the remaining divisor divides element_count.
            element_count = (element_count / (i / a))
                .checked_mul(numerator / a)
                .ok_or(IsotopeDistributionError::TheoreticalIsotopologueCountOverflow)?;
        }
        total = total
            .checked_mul(element_count)
            .ok_or(IsotopeDistributionError::TheoreticalIsotopologueCountOverflow)?;
    }
    Ok(total)
}

/// Calculates a nominal-mass isotope envelope for a molecular formula.
///
/// Isotopes with the same nominal mass are combined into one peak. Its `mass`
/// is the abundance-weighted centroid of the exact isotope masses in that peak.
pub fn nominal_isotope_distribution(
    formula: &Formula,
) -> Result<Vec<IsotopePeak>, IsotopeDistributionError> {
    let mut peaks = BTreeMap::from([(0_u32, (1.0, 0.0))]);

    for atom_count in formula.atom_counts() {
        let isotopes = atom_isotopes(atom_count.atom)?;
        for _ in 0..atom_count.count {
            let mut next_peaks: BTreeMap<u32, (f64, f64)> = BTreeMap::new();
            for (&nominal_mass, &(abundance, weighted_mass)) in &peaks {
                let centroid_mass = weighted_mass / abundance;
                for &(isotope, isotope_abundance) in &isotopes {
                    let combined_abundance = abundance * isotope_abundance;
                    let combined_nominal_mass = nominal_mass + u32::from(isotope.id.mass_number);
                    let entry = next_peaks.entry(combined_nominal_mass).or_default();
                    entry.0 += combined_abundance;
                    entry.1 += combined_abundance * (centroid_mass + isotope.relative_atomic_mass);
                }
            }
            peaks = next_peaks;
        }
    }

    let total_abundance: f64 = peaks.values().map(|(abundance, _)| abundance).sum();
    Ok(peaks
        .into_iter()
        .map(|(nominal_mass, (abundance, weighted_mass))| IsotopePeak {
            nominal_mass,
            abundance: abundance / total_abundance,
            mass: weighted_mass / abundance,
        })
        .collect())
}

/// Calculates isotope fine structure using a composition-keyed forward trellis.
///
/// Inspired by the forward-trellis dynamic programming and state-pruning method
/// in the [isotope-distribution paper](https://www.sciencedirect.com/science/article/pii/S1044030507004308),
/// equation (8) and the "Most Probable Exact Masses" section. This implementation
/// uses a cumulative probability-coverage budget instead of a fixed top-N cutoff.
///
/// Paths that differ only in atom ordering are summed before pruning. Distinct
/// isotope compositions are never merged by nominal mass or a mass tolerance.
/// Explicit isotope labels are fixed; other atoms use normalized natural abundances.
/// Each peak retains its complete isotope composition, including fixed atoms.
///
/// The allowed probability loss is spread evenly over stochastic atom additions.
/// At each step the most probable states are retained until that step's coverage
/// budget is met. The final retained probability meets `options.coverage` to an
/// absolute floating-point tolerance of 1e-12, or an error is returned.
///
/// Pruning removes paths that could later reach a retained composition, so peak
/// abundances are lower-bound approximations, not exact multinomial probabilities.
/// They are not renormalized, and the output is not guaranteed to be the globally
/// most probable set of compositions. Coverage 1 disables pruning and recovers
/// exhaustive multinomial probabilities, subject to the state limit and roundoff.
///
/// Unlike a fixed top-N trellis, exceeding `max_states` returns an error rather
/// than silently sacrificing coverage. This also means a calculation can fail at
/// an intermediate step even if its final distribution would fit the limit.
///
/// ```
/// use ms_core::formula::Formula;
/// use ms_core::isotope_distribution::{
///     fine_isotope_distribution, FineIsotopeDistributionOptions,
/// };
///
/// let result = fine_isotope_distribution(
///     &Formula::parse("C2H6O").unwrap(),
///     FineIsotopeDistributionOptions::default(),
/// ).unwrap();
/// assert!(result.retained_probability >= 0.9999 - 1e-12);
/// for peak in &result.peaks {
///     assert_eq!(peak.composition.iter().map(|entry| entry.count).sum::<u64>(), 9);
/// }
/// ```
pub fn fine_isotope_distribution(
    formula: &Formula,
    options: FineIsotopeDistributionOptions,
) -> Result<FineIsotopeDistribution, IsotopeDistributionError> {
    options.validate()?;
    let model = FineIsotopeModel::from_formula(formula)?;

    let mut states = vec![IsotopeState {
        composition: vec![0; model.isotopes.len()],
        probability: 1.0,
    }];
    let mut step = 0_u64;
    for element in &model.elements {
        for _ in 0..element.atom_count {
            states = expand_isotope_states(&states, &element.transitions);
            step += 1;
            let target_coverage =
                1.0 - (1.0 - options.coverage) * (step as f64 / model.stochastic_atom_count as f64);
            prune_isotope_states(&mut states, target_coverage, options)?;
        }
    }

    let mut peaks: Vec<_> = states.into_iter().map(|state| model.peak(state)).collect();
    peaks.sort_by(|left, right| left.mass.total_cmp(&right.mass));
    let retained_probability = peaks.iter().map(|peak| peak.abundance).sum::<f64>();
    if retained_probability + 1e-12 < options.coverage {
        return Err(IsotopeDistributionError::ProbabilityCoverageNotReached);
    }
    Ok(FineIsotopeDistribution {
        peaks,
        retained_probability,
    })
}

struct IsotopeState {
    composition: Vec<u32>,
    probability: f64,
}

impl IsotopeState {
    fn new(composition: Vec<u32>, probability: f64) -> Self {
        Self {
            composition,
            probability,
        }
    }
}

struct ElementTransitions {
    atom_count: u32,
    transitions: Vec<(usize, f64)>,
}

struct FineIsotopeModel {
    fixed_mass: f64,
    fixed_nominal_mass: u64,
    fixed_composition: BTreeMap<IsotopeId, u64>,
    isotopes: Vec<&'static IsotopeData>,
    elements: Vec<ElementTransitions>,
    stochastic_atom_count: u64,
}

impl Default for FineIsotopeModel {
    fn default() -> Self {
        Self {
            fixed_mass: 0.0,
            fixed_nominal_mass: 0,
            fixed_composition: BTreeMap::new(),
            isotopes: Vec::new(),
            elements: Vec::new(),
            stochastic_atom_count: 0,
        }
    }
}

impl FineIsotopeModel {
    /// Constructs a fine isotope model from a chemical formula.
    fn from_formula(formula: &Formula) -> Result<Self, IsotopeDistributionError> {
        let mut model = Self::default();

        for atom_count in formula.atom_counts() {
            // Get the isotopes for the current atom
            let isotopes = atom_isotopes(atom_count.atom)?;
            let count = atom_count.count.unsigned_abs();

            // If the atom has only one isotope, it contributes to the fixed part of the model.
            if isotopes.len() == 1 {
                let isotope = isotopes[0].0;
                model.fixed_mass += f64::from(count) * isotope.relative_atomic_mass;
                model.fixed_nominal_mass += u64::from(count) * u64::from(isotope.id.mass_number);
                *model.fixed_composition.entry(isotope.id).or_default() += u64::from(count);
            } else {
                // Otherwise, the atom has multiple isotopes and contributes to the stochastic part of the model.
                let offset = model.isotopes.len();
                let transitions = isotopes
                    .into_iter()
                    .enumerate()
                    .map(|(index, (isotope, abundance))| {
                        model.isotopes.push(isotope);
                        (offset + index, abundance)
                    })
                    .collect();
                model.elements.push(ElementTransitions {
                    atom_count: count,
                    transitions,
                });
                model.stochastic_atom_count += u64::from(count);
            }
        }
        Ok(model)
    }

    /// Computes the fine isotope peak for a given isotope state.
    fn peak(&self, state: IsotopeState) -> FineIsotopePeak {
        let mut mass = self.fixed_mass;
        let mut nominal_mass = self.fixed_nominal_mass;
        let mut isotope_counts = self.fixed_composition.clone();
        for (count, isotope) in state.composition.into_iter().zip(&self.isotopes) {
            mass += f64::from(count) * isotope.relative_atomic_mass;
            nominal_mass += u64::from(count) * u64::from(isotope.id.mass_number);
            if count > 0 {
                *isotope_counts.entry(isotope.id).or_default() += u64::from(count);
            }
        }
        FineIsotopePeak {
            nominal_mass,
            abundance: state.probability,
            mass,
            composition: isotope_counts
                .into_iter()
                .map(|(isotope, count)| IsotopeCount { isotope, count })
                .collect(),
        }
    }
}

/// Expands the given isotope states by applying the specified transitions
///  generating new isotope states based on the transitions.
fn expand_isotope_states(
    states: &[IsotopeState],
    transitions: &[(usize, f64)],
) -> Vec<IsotopeState> {
    let mut candidates = BTreeMap::<Vec<u32>, f64>::new();
    for state in states {
        for &(index, abundance) in transitions {
            let mut composition = state.composition.clone();
            composition[index] += 1;
            *candidates.entry(composition).or_default() += state.probability * abundance;
        }
    }
    candidates
        .into_iter()
        .map(|(composition, probability)| IsotopeState {
            composition,
            probability,
        })
        .collect()
}

fn prune_isotope_states(
    states: &mut Vec<IsotopeState>,
    target_coverage: f64,
    options: FineIsotopeDistributionOptions,
) -> Result<(), IsotopeDistributionError> {
    states.sort_by(|left, right| {
        right
            .probability
            .total_cmp(&left.probability)
            .then_with(|| left.composition.cmp(&right.composition))
    });

    let mut retained = 0.0;
    let keep = if options.coverage == 1.0 {
        states.len()
    } else {
        states
            .iter()
            .position(|state| {
                retained += state.probability;
                retained >= target_coverage
            })
            .map_or(states.len(), |index| index + 1)
    };
    if keep > options.max_states {
        return Err(IsotopeDistributionError::StateLimitExceeded {
            max_states: options.max_states,
        });
    }
    states.truncate(keep);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::isotopes::isotope_data;

    const SNAPSHOT_FORMULAS: [&str; 5] = ["H2O", "C2H6O", "C2H5NO2", "S2Cl2", "Ca2"];

    #[test]
    fn counts_theoretical_isotopologues_including_fixed_labels() {
        for (input, expected) in [
            ("C", 2),
            ("C2", 3),
            ("C2C3", 6),
            ("H2O", 9),
            ("C2H6O", 63),
            ("C2H5NO2", 216),
            ("S2Cl2", 30),
            ("Ca2", 21),
            ("^13C2^2H3Na", 1),
            ("C2^13C", 3),
            ("Na^23Na", 1),
            ("^99Tc", 1),
        ] {
            assert_eq!(
                theoretical_isotopologues(&Formula::parse(input).unwrap()).unwrap(),
                expected,
                "{input}"
            );
        }
    }

    #[test]
    fn counts_large_theoretical_distributions_without_expansion() {
        for (input, expected) in [
            ("C2147483647", 2_147_483_648_u128),
            (
                "Xe200000",
                63_503_492_930_194_731_049_576_842_180_679_115_001,
            ),
            ("C254H377N65O75S6", 1_563_613_904_160),
        ] {
            assert_eq!(
                theoretical_isotopologues(&Formula::parse(input).unwrap()).unwrap(),
                expected,
                "{input}"
            );
        }
    }

    #[test]
    fn reports_theoretical_count_overflow_for_an_element_or_the_molecular_product() {
        for input in [
            "Sn2147483647",
            "C2147483647H2147483647N2147483647Cl2147483647Br2147483647",
        ] {
            assert_eq!(
                theoretical_isotopologues(&Formula::parse(input).unwrap()),
                Err(IsotopeDistributionError::TheoreticalIsotopologueCountOverflow),
                "{input}"
            );
        }
    }

    #[test]
    fn calculates_and_normalizes_the_carbon_isotope_envelope() {
        let distribution = nominal_isotope_distribution(&Formula::parse("C").unwrap()).unwrap();
        assert_eq!(distribution.len(), 2);
        assert_eq!(distribution[0].nominal_mass, 12);
        assert_eq!(distribution[1].nominal_mass, 13);
        assert!((distribution[0].abundance - 0.9893).abs() < 1e-6);
        assert!((distribution[1].abundance - 0.0107).abs() < 1e-6);
        assert!((distribution.iter().map(|peak| peak.abundance).sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn combines_isotope_combinations_with_the_same_nominal_mass() {
        let distribution = nominal_isotope_distribution(&Formula::parse("C2").unwrap()).unwrap();
        assert_eq!(
            distribution
                .iter()
                .map(|peak| peak.nominal_mass)
                .collect::<Vec<_>>(),
            [24, 25, 26]
        );
        assert!(distribution[1].abundance > 0.02);
    }

    #[test]
    fn treats_explicit_isotopes_as_fixed() {
        let distribution = nominal_isotope_distribution(&Formula::parse("^13C").unwrap()).unwrap();
        assert_eq!(distribution.len(), 1);
        assert_eq!(distribution[0].nominal_mass, 13);
        assert_eq!(distribution[0].abundance, 1.0);
        assert_eq!(
            distribution[0].mass,
            isotope_data(crate::isotopes::IsotopeId {
                atomic_number: 6,
                mass_number: 13,
            })
            .unwrap()
            .relative_atomic_mass
        );
    }

    #[test]
    fn calculates_multielement_formula_distribution() {
        let distribution = nominal_isotope_distribution(&Formula::parse("H2O").unwrap()).unwrap();
        assert!((distribution.iter().map(|peak| peak.abundance).sum::<f64>() - 1.0).abs() < 1e-12);
        assert_eq!(distribution.first().unwrap().nominal_mass, 18);

        insta::assert_yaml_snapshot!(distribution);
    }

    #[test]
    fn snapshots_nominal_isotope_distributions() {
        for input in SNAPSHOT_FORMULAS {
            let distribution =
                nominal_isotope_distribution(&Formula::parse(input).unwrap()).unwrap();
            assert!(
                (distribution.iter().map(|peak| peak.abundance).sum::<f64>() - 1.0).abs() < 1e-12,
                "{input}"
            );
            insta::assert_yaml_snapshot!(
                format!("nominal_isotope_distribution_{input}"),
                distribution
            );
        }
    }

    fn exhaustive_fine_distribution(input: &str) -> FineIsotopeDistribution {
        fine_isotope_distribution(
            &Formula::parse(input).unwrap(),
            FineIsotopeDistributionOptions {
                coverage: 1.0,
                max_states: 10_000,
            },
        )
        .unwrap()
    }

    fn fine_distribution_snapshot(distribution: &FineIsotopeDistribution) -> impl Serialize + '_ {
        #[derive(Serialize)]
        struct CompositionSnapshot<'a> {
            isotope_symbol: String,
            #[serde(flatten)]
            isotope_count: &'a IsotopeCount,
        }

        #[derive(Serialize)]
        struct PeakSnapshot<'a> {
            nominal_mass: u64,
            abundance: f64,
            mass: f64,
            composition: Vec<CompositionSnapshot<'a>>,
        }

        #[derive(Serialize)]
        struct DistributionSnapshot<'a> {
            peaks: Vec<PeakSnapshot<'a>>,
            retained_probability: f64,
        }

        DistributionSnapshot {
            peaks: distribution
                .peaks
                .iter()
                .map(|peak| PeakSnapshot {
                    nominal_mass: peak.nominal_mass,
                    abundance: peak.abundance,
                    mass: peak.mass,
                    composition: peak
                        .composition
                        .iter()
                        .map(|entry| CompositionSnapshot {
                            isotope_symbol: isotope_data(entry.isotope)
                                .expect("snapshot compositions contain known isotopes")
                                .isotope_symbol(),
                            isotope_count: entry,
                        })
                        .collect(),
                })
                .collect(),
            retained_probability: distribution.retained_probability,
        }
    }

    fn multinomial_probability(counts_and_probabilities: &[(u32, f64)]) -> f64 {
        let factorial = |n: u32| (1..=n).map(f64::from).product::<f64>();
        let total_count = counts_and_probabilities
            .iter()
            .map(|&(count, _)| count)
            .sum();
        factorial(total_count)
            * counts_and_probabilities
                .iter()
                .map(|&(count, probability)| probability.powf(f64::from(count)) / factorial(count))
                .product::<f64>()
    }

    #[test]
    fn fine_structure_includes_binomial_multiplicity() {
        let result = exhaustive_fine_distribution("C2");
        let p12 = 0.9893_f64;
        let p13 = 0.0107_f64;
        assert_eq!(result.peaks.len(), 3);
        for (peak, expected) in result
            .peaks
            .iter()
            .zip([p12 * p12, 2.0 * p12 * p13, p13 * p13])
        {
            assert!((peak.abundance - expected).abs() < 1e-14);
        }
        assert!((result.retained_probability - 1.0).abs() < 1e-14);
        assert_eq!(
            result.peaks[1].mass,
            crate::test_support::C_12_MASS + crate::test_support::C_13_MASS
        );
    }

    #[test]
    fn fine_structure_resolves_same_nominal_mass_substitutions() {
        let result = exhaustive_fine_distribution("CH");
        assert_eq!(result.peaks.len(), 4);
        let nominal_14: Vec<_> = result
            .peaks
            .iter()
            .filter(|peak| peak.nominal_mass == 14)
            .collect();
        assert_eq!(nominal_14.len(), 2);
        assert_ne!(nominal_14[0].composition, nominal_14[1].composition);
        assert!((nominal_14[1].mass - nominal_14[0].mass - 0.00292191082).abs() < 1e-10);
        assert!((nominal_14[0].abundance - 0.0107 * 0.999885).abs() < 1e-12);
        assert!((nominal_14[1].abundance - 0.9893 * 0.000115).abs() < 1e-12);
    }

    #[test]
    fn exhaustive_fine_structure_matches_nominal_probabilities_and_centroids() {
        for input in SNAPSHOT_FORMULAS {
            let formula = Formula::parse(input).unwrap();
            let fine = exhaustive_fine_distribution(input);
            assert_eq!(
                theoretical_isotopologues(&formula).unwrap(),
                fine.peaks.len() as u128,
                "{input}"
            );
            let nominal = nominal_isotope_distribution(&formula).unwrap();
            let mut grouped = BTreeMap::<u64, (f64, f64)>::new();
            for peak in &fine.peaks {
                let entry = grouped.entry(peak.nominal_mass).or_default();
                entry.0 += peak.abundance;
                entry.1 += peak.abundance * peak.mass;
            }
            assert_eq!(grouped.len(), nominal.len(), "{input}");
            for peak in nominal {
                let (abundance, weighted_mass) = grouped[&u64::from(peak.nominal_mass)];
                assert!((abundance - peak.abundance).abs() < 1e-12, "{input}");
                assert!(
                    (weighted_mass / abundance - peak.mass).abs() < 1e-10,
                    "{input}"
                );
            }
            assert!((fine.retained_probability - 1.0).abs() < 1e-12, "{input}");
            assert!(
                fine.peaks
                    .windows(2)
                    .all(|pair| pair[0].mass <= pair[1].mass)
            );
            insta::assert_yaml_snapshot!(
                format!("exhaustive_fine_structure_{input}"),
                fine_distribution_snapshot(&fine)
            );
        }
    }

    #[test]
    fn fine_structure_matches_water_multinomial_probabilities() {
        let result = exhaustive_fine_distribution("H2O");
        assert_eq!(result.peaks.len(), 9);
        let hydrogen = atom_isotopes(Formula::parse("H").unwrap().atom_counts()[0].atom).unwrap();
        let oxygen = atom_isotopes(Formula::parse("O").unwrap().atom_counts()[0].atom).unwrap();
        for deuterium_count in 0..=2 {
            for &(isotope, oxygen_abundance) in &oxygen {
                let mass = f64::from(2 - deuterium_count) * hydrogen[0].0.relative_atomic_mass
                    + f64::from(deuterium_count) * hydrogen[1].0.relative_atomic_mass
                    + isotope.relative_atomic_mass;
                let probability = multinomial_probability(&[
                    (2 - deuterium_count, hydrogen[0].1),
                    (deuterium_count, hydrogen[1].1),
                ]) * oxygen_abundance;
                let peak = result
                    .peaks
                    .iter()
                    .find(|peak| (peak.mass - mass).abs() < 1e-12)
                    .unwrap();
                assert!((peak.abundance - probability).abs() < 1e-14);
            }
        }
    }

    #[test]
    fn fine_structure_keeps_explicit_labels_and_single_isotope_elements_fixed() {
        let fixed = exhaustive_fine_distribution("^13C2^2H3Na");
        assert_eq!(fixed.peaks.len(), 1);
        assert_eq!(fixed.peaks[0].nominal_mass, 55);
        assert_eq!(fixed.peaks[0].abundance, 1.0);
        assert!(
            (fixed.peaks[0].mass - Formula::parse("^13C2^2H3Na").unwrap().mass()).abs() < 1e-12
        );

        let mixed = exhaustive_fine_distribution("C2^13C");
        let natural = exhaustive_fine_distribution("C2");
        assert_eq!(mixed.peaks.len(), natural.peaks.len());
        for (mixed, natural) in mixed.peaks.iter().zip(natural.peaks) {
            assert_eq!(mixed.abundance, natural.abundance);
            assert_eq!(mixed.nominal_mass, natural.nominal_mass + 13);
            assert!((mixed.mass - natural.mass - crate::test_support::C_13_MASS).abs() < 1e-12);
        }
        let all_carbon_13 = mixed.peaks.last().unwrap();
        assert_eq!(all_carbon_13.composition.len(), 1);
        assert_eq!(all_carbon_13.composition[0].isotope.mass_number, 13);
        assert_eq!(all_carbon_13.composition[0].count, 3);
    }

    fn assert_peak_matches_formula(formula: &Formula, peak: &FineIsotopePeak) {
        assert!(!peak.composition.is_empty(), "{formula}");
        assert!(
            peak.composition
                .windows(2)
                .all(|pair| pair[0].isotope < pair[1].isotope),
            "{formula}"
        );

        let mut expected_elements = BTreeMap::new();
        for atom_count in formula.atom_counts() {
            *expected_elements
                .entry(atom_count.atom.atomic_number())
                .or_insert(0_u64) += u64::from(atom_count.count.unsigned_abs());
        }

        let mut actual_elements = BTreeMap::new();
        let mut mass = 0.0;
        let mut nominal_mass = 0_u64;
        for entry in &peak.composition {
            assert!(entry.count > 0, "{formula}");
            let isotope = isotope_data(entry.isotope).unwrap();
            *actual_elements
                .entry(entry.isotope.atomic_number)
                .or_insert(0_u64) += entry.count;
            mass += entry.count as f64 * isotope.relative_atomic_mass;
            nominal_mass += entry.count * u64::from(entry.isotope.mass_number);
        }
        assert_eq!(actual_elements, expected_elements, "{formula}");
        assert_eq!(nominal_mass, peak.nominal_mass, "{formula}");
        assert!((mass - peak.mass).abs() < 1e-10, "{formula}");

        for atom_count in formula
            .atom_counts()
            .iter()
            .filter(|entry| entry.atom.isotope_was_specified())
        {
            assert!(
                peak.composition.iter().any(|entry| {
                    entry.isotope.atomic_number == atom_count.atom.atomic_number()
                        && entry.isotope.mass_number == atom_count.atom.mass_number()
                        && entry.count >= u64::from(atom_count.count.unsigned_abs())
                }),
                "fixed isotope {atom_count} missing from peak for {formula}"
            );
        }
    }

    #[test]
    fn fine_structure_retains_complete_compositions_before_and_after_pruning() {
        for input in [
            "CH",
            "H2O",
            "C2H5NO2",
            "^13C2^2H3Na",
            "C2^13C",
            "Na^23Na",
            "^99Tc",
        ] {
            let formula = Formula::parse(input).unwrap();
            for coverage in [1.0, 0.99] {
                let result = fine_isotope_distribution(
                    &formula,
                    FineIsotopeDistributionOptions::new(coverage, 10_000),
                )
                .unwrap();
                let mut compositions = std::collections::BTreeSet::new();
                for peak in result.peaks {
                    assert_peak_matches_formula(&formula, &peak);
                    assert!(
                        compositions.insert(
                            peak.composition
                                .iter()
                                .map(|entry| (entry.isotope, entry.count))
                                .collect::<Vec<_>>()
                        ),
                        "{input}"
                    );
                }
            }
        }
    }

    #[test]
    fn fine_structure_supports_large_fixed_nominal_masses_without_atom_iteration() {
        let result = exhaustive_fine_distribution("^13C2147483647");
        assert_eq!(result.peaks.len(), 1);
        assert_eq!(result.peaks[0].nominal_mass, 13 * 2_147_483_647_u64);
        assert_eq!(result.retained_probability, 1.0);
        assert_eq!(result.peaks[0].composition.len(), 1);
        assert_eq!(result.peaks[0].composition[0].count, 2_147_483_647);
    }

    #[test]
    fn pruned_fine_structure_preserves_absolute_probability_and_coverage() {
        let formula = Formula::parse("C4H8O2").unwrap();
        let exhaustive = exhaustive_fine_distribution("C4H8O2");
        for coverage in [0.5, 0.99, 0.9999] {
            let result = fine_isotope_distribution(
                &formula,
                FineIsotopeDistributionOptions {
                    coverage,
                    max_states: 10_000,
                },
            )
            .unwrap();
            assert!(result.retained_probability >= coverage - 1e-12);
            assert!(result.retained_probability < 1.0);
            assert!(result.peaks.len() < exhaustive.peaks.len());
            assert_eq!(
                result.retained_probability,
                result.peaks.iter().map(|peak| peak.abundance).sum::<f64>()
            );
            for peak in &result.peaks {
                let exact = exhaustive
                    .peaks
                    .iter()
                    .find(|exact| exact.composition == peak.composition)
                    .unwrap();
                assert_eq!(peak.mass, exact.mass);
                assert!(peak.abundance <= exact.abundance + 1e-14);
            }
        }
    }

    #[test]
    fn fine_structure_rejects_invalid_options_and_insufficient_state_limits() {
        let formula = Formula::parse("C2").unwrap();
        for coverage in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1, 0.0, 1.1] {
            assert_eq!(
                fine_isotope_distribution(
                    &formula,
                    FineIsotopeDistributionOptions {
                        coverage,
                        ..Default::default()
                    },
                ),
                Err(IsotopeDistributionError::InvalidCoverage)
            );
        }
        assert_eq!(
            fine_isotope_distribution(
                &formula,
                FineIsotopeDistributionOptions {
                    max_states: 0,
                    ..Default::default()
                },
            ),
            Err(IsotopeDistributionError::InvalidMaxStates)
        );
        for coverage in [0.9999, 1.0] {
            assert_eq!(
                fine_isotope_distribution(
                    &formula,
                    FineIsotopeDistributionOptions {
                        coverage,
                        max_states: 1,
                    },
                ),
                Err(IsotopeDistributionError::StateLimitExceeded { max_states: 1 })
            );
        }
        assert!(
            fine_isotope_distribution(
                &formula,
                FineIsotopeDistributionOptions {
                    coverage: 0.9,
                    max_states: 1
                },
            )
            .is_ok()
        );
    }

    #[test]
    fn fine_structure_reports_missing_natural_abundances_but_allows_labels() {
        let atom = Atom::from_isotope_id(
            crate::isotopes::IsotopeId {
                atomic_number: 43,
                mass_number: 99,
            },
            false,
        );
        let formula =
            Formula::from_atom_counts(vec![crate::formula::AtomCount { atom, count: 1 }]).unwrap();
        assert_eq!(
            theoretical_isotopologues(&formula),
            Err(IsotopeDistributionError::ElementHasNoAbundanceData("Tc"))
        );
        assert_eq!(
            fine_isotope_distribution(&formula, FineIsotopeDistributionOptions::default()),
            Err(IsotopeDistributionError::ElementHasNoAbundanceData("Tc"))
        );
        let labeled = exhaustive_fine_distribution("^99Tc");
        assert_eq!(labeled.peaks.len(), 1);
        assert_eq!(labeled.retained_probability, 1.0);
    }

    #[test]
    fn fine_structure_reaches_coverage_for_bovine_insulin_without_exhaustive_expansion() {
        let options = FineIsotopeDistributionOptions::default();
        let result =
            fine_isotope_distribution(&Formula::parse("C254H377N65O75S6").unwrap(), options)
                .unwrap();
        assert!(result.retained_probability >= options.coverage - 1e-12);
        assert!(result.retained_probability < 1.0);
        assert!(result.peaks.len() <= options.max_states);
        assert!(
            result
                .peaks
                .iter()
                .all(|peak| peak.mass.is_finite() && peak.abundance > 0.0)
        );
    }
}

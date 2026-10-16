/// Module for handling chemical formulas in mass spectrometry.
use crate::{
    isotopes::{IsotopeData, IsotopeId, isotope_data},
    parser::{self, FormulaParseError},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Atom {
    isotope: IsotopeId,
    isotope_was_specified: bool,
}

impl Atom {
    pub(crate) fn from_isotope_id(isotope: IsotopeId, isotope_was_specified: bool) -> Self {
        Self {
            isotope,
            isotope_was_specified,
        }
    }

    pub(crate) fn data(&self) -> &'static IsotopeData {
        isotope_data(self.isotope).expect("Atom is created only from a valid isotope")
    }

    pub fn symbol(&self) -> &'static str {
        self.data().symbol
    }

    pub fn atomic_number(&self) -> u8 {
        self.isotope.atomic_number
    }

    pub fn mass_number(&self) -> u16 {
        self.isotope.mass_number
    }

    pub fn isotope_was_specified(&self) -> bool {
        self.isotope_was_specified
    }

    pub fn relative_atomic_mass(&self) -> f64 {
        self.data().relative_atomic_mass
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AtomCount {
    pub atom: Atom,
    pub count: i32,
}

impl std::fmt::Display for AtomCount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.count == 0 {
            return write!(f, "0");
        }

        let count = self.count.unsigned_abs();
        if self.count < 0 {
            write!(f, "-")?;
        }
        write!(f, "{}", self.atom)?;
        if count != 1 {
            write!(f, "{}", count)?;
        }
        Ok(())
    }
}

impl AtomCount {
    pub fn mass(&self) -> f64 {
        self.atom.relative_atomic_mass() * self.count as f64
    }
}

impl std::fmt::Display for Atom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.isotope_was_specified {
            write!(f, "^{}{}", self.mass_number(), self.symbol())?;
        } else {
            write!(f, "{}", self.symbol())?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Formula {
    atom_counts: Vec<AtomCount>,
}

pub struct FormulaDelta {
    atom_counts: Vec<AtomCount>,
}

fn is_valid_formula(atom_counts: &[AtomCount]) -> bool {
    !atom_counts.is_empty() && atom_counts.iter().all(|ac| ac.count > 0)
}

fn hill_order(atom: Atom) -> (u8, &'static str, u16, bool) {
    let symbol = atom.symbol();
    let priority = match symbol {
        "C" => 0,
        "H" => 1,
        _ => 2,
    };
    (
        priority,
        symbol,
        atom.mass_number(),
        atom.isotope_was_specified(),
    )
}

pub struct HeteroatomRatios {
    /// H/C ratio.
    pub h_to_c: f64,
    /// O/C ratio.
    pub o_to_c: f64,
}

impl Formula {
    pub(crate) fn from_atom_counts(atom_counts: Vec<AtomCount>) -> Result<Self, FormulaParseError> {
        if !is_valid_formula(&atom_counts) {
            let invalid_count = atom_counts
                .iter()
                .find(|atom_count| atom_count.count <= 0)
                .map_or(0, |atom_count| atom_count.count);
            return Err(FormulaParseError::InvalidAtomCount(
                invalid_count.to_string(),
            ));
        }
        Ok(Self { atom_counts })
    }

    pub fn parse(input: &str) -> Result<Self, FormulaParseError> {
        parser::parse_formula(input)
    }

    pub fn atom_counts(&self) -> &[AtomCount] {
        &self.atom_counts
    }

    pub fn mass(&self) -> f64 {
        self.atom_counts.iter().map(|ac| ac.mass()).sum()
    }

    /// Returns the signed atom-count difference between this formula and another formula.
    pub fn difference(&self, other: &Self) -> FormulaDelta {
        let mut result_counts: Vec<AtomCount> = self
            .atom_counts
            .iter()
            .map(|atom_count| AtomCount {
                atom: atom_count.atom,
                count: atom_count.count,
            })
            .collect();

        for other_ac in &other.atom_counts {
            if let Some(pos) = result_counts.iter().position(|ac| ac.atom == other_ac.atom) {
                result_counts[pos].count -= other_ac.count;
            } else {
                result_counts.push(AtomCount {
                    atom: other_ac.atom,
                    count: -other_ac.count,
                });
            }
        }
        result_counts.retain(|atom_count| atom_count.count != 0);
        result_counts.sort_by_key(|atom_count| hill_order(atom_count.atom));
        FormulaDelta {
            atom_counts: result_counts,
        }
    }

    /// Calculates the double bond equivalent (DBE) of the formula.
    /// 
    /// This is given by the formula: DBE = (2C + 2 + N - H - X) / 2
    /// where C, H, N are the counts of carbon, hydrogen, and nitrogen atoms, respectively,
    /// and X is the total count of halogen atoms (F, Cl, Br, I).
    pub fn dbe(&self) -> f64 {

        let (mut c, mut h, mut n, mut halogen_count) = (0, 0, 0, 0);
        for ac in &self.atom_counts {
            match ac.atom.symbol() {
                "C" => c = ac.count,
                "H" => h = ac.count,
                "N" => n = ac.count,
                "F" | "Cl" | "Br" | "I" => halogen_count += ac.count,
                _ => {}
            }
        }

        (2 * c + 2 + n - h - halogen_count) as f64 / 2.0
    }

    /// Returns the ratios of heteroatoms (H/C and O/C) in the formula.
    pub fn heteroatom_ratios(&self) -> HeteroatomRatios {
        let mut c = 0;
        let mut h = 0;
        let mut o = 0;

        for ac in &self.atom_counts {
            match ac.atom.symbol() {
                "C" => c = ac.count,
                "H" => h = ac.count,
                "O" => o = ac.count,
                _ => {}
            }
        }
        HeteroatomRatios {
            h_to_c: if c != 0 { h as f64 / c as f64 } else { 0.0 },
            o_to_c: if c != 0 { o as f64 / c as f64 } else { 0.0 },
        }
    }
}

impl std::fmt::Display for Formula {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for atom_count in &self.atom_counts {
            write!(f, "{}", atom_count)?;
        }
        Ok(())
    }
}

impl FormulaDelta {
    pub fn atom_counts(&self) -> &[AtomCount] {
        &self.atom_counts
    }

    /// Splits this delta into (removed, added) formula components.
    /// A side is `None` when it contains no atoms.
    pub fn as_split(&self) -> (Option<Formula>, Option<Formula>) {
        let removed: Vec<AtomCount> = self
            .atom_counts
            .iter()
            .filter(|atom_count| atom_count.count < 0)
            .map(|atom_count| AtomCount {
                atom: atom_count.atom,
                count: -atom_count.count,
            })
            .collect();
        let added: Vec<AtomCount> = self
            .atom_counts
            .iter()
            .filter(|atom_count| atom_count.count > 0)
            .copied()
            .collect();

        let to_formula = |atom_counts: Vec<AtomCount>| {
            if atom_counts.is_empty() {
                None
            } else {
                Some(Formula { atom_counts })
            }
        };

        (to_formula(removed), to_formula(added))
    }

    pub fn is_valid_formula(&self) -> bool {
        is_valid_formula(&self.atom_counts)
    }

    pub fn mass(&self) -> f64 {
        self.atom_counts
            .iter()
            .map(|atom_count| atom_count.mass())
            .sum()
    }
}

#[cfg(test)]
mod tests {

    use super::*;
    use crate::MILLI_DALTON;
    use crate::test_support::{C_12_MASS, C_13_MASS, H_1_MASS, O_16_MASS};

    #[test]
    fn displays_isotope_notation_and_non_unit_counts() {
        let carbon_13 = AtomCount {
            atom: Atom::from_isotope_id(
                IsotopeId {
                    atomic_number: 6,
                    mass_number: 13,
                },
                true,
            ),
            count: 1,
        };
        let oxygen_16 = AtomCount {
            atom: Atom::from_isotope_id(
                IsotopeId {
                    atomic_number: 8,
                    mass_number: 16,
                },
                true,
            ),
            count: 2,
        };

        assert_eq!(carbon_13.to_string(), "^13C");
        assert_eq!(oxygen_16.to_string(), "^16O2");
    }

    #[test]
    fn atom_exposes_properties_without_exposing_the_isotope_id() {
        let atom = Atom::from_isotope_id(
            IsotopeId {
                atomic_number: 6,
                mass_number: 13,
            },
            true,
        );
        assert_eq!(atom.symbol(), "C");
        assert_eq!(atom.mass_number(), 13);
        assert!(atom.isotope_was_specified());
        assert_eq!(atom.relative_atomic_mass(), C_13_MASS);
    }

    #[test]
    fn displays_formula_atoms_consecutively() {
        let formula = Formula::parse("^13CH2O").unwrap();
        assert_eq!(formula.to_string(), "^13CH2O");
    }

    #[test]
    fn calculates_formula_mass() {
        let formula = Formula::parse("C6H12O6").unwrap();
        let expected_mass = 6.0 * C_12_MASS + 12.0 * H_1_MASS + 6.0 * O_16_MASS;
        assert_eq!(formula.mass(), expected_mass);
    }

    #[test]
    fn calculates_formula_difference() {
        let formula1 = Formula::parse("C6H12O6").unwrap();
        let formula2 = Formula::parse("C2H4O2").unwrap();
        let difference = formula1.difference(&formula2);
        let (removed, added) = difference.as_split();
        assert_eq!(removed, None);
        assert_eq!(added.unwrap().to_string(), "C4H8O4");

        let formula3 = Formula::parse("H2O").unwrap();
        let formula4 = Formula::parse("C6H12O6").unwrap();
        let neg_difference = formula3.difference(&formula4);
        let (removed, added) = neg_difference.as_split();
        assert_eq!(removed.unwrap().to_string(), "C6H10O5");
        assert_eq!(added, None);

        let mixed_difference = Formula::parse("C2H6O")
            .unwrap()
            .difference(&Formula::parse("CH4O2").unwrap());
        let (removed, added) = mixed_difference.as_split();
        assert_eq!(removed.unwrap().to_string(), "O");
        assert_eq!(added.unwrap().to_string(), "CH2");
    }

    #[test]
    fn splits_formula_difference_into_removed_and_added_components() {
        let original = Formula::parse("C14H23S").unwrap();
        let target = Formula::parse("C17H19").unwrap();
        let (removed, added) = original.difference(&target).as_split();

        let removed = removed.unwrap();
        let added = added.unwrap();

        assert_eq!(removed.to_string(), "C3");
        assert_eq!(added.to_string(), "H4S");

        // diff in mass should be ~3.4 mDA
        let mass_diff = added.mass() - removed.mass();
        assert_eq!(
            (mass_diff * 1000.0).round(),
            (3.371f64 * MILLI_DALTON * 1000.0).round()
        );
    }

    #[test]
    fn equal_formulas_have_no_split_components() {
        let formula = Formula::parse("C6H12O6").unwrap();
        let (removed, added) = formula.difference(&formula).as_split();

        assert_eq!(removed, None);
        assert_eq!(added, None);
    }

    #[test]
    fn calculates_double_bond_equivalent() {
        let formula = Formula::parse("C6H12O6").unwrap();
        assert_eq!(formula.dbe(), 1.0);
        // implausible DBE value for a saturated compound
        let formula = Formula::parse("C6H17O6").unwrap();
        assert_eq!(formula.dbe(), -1.5);
        // Multiple halogens
        let formula = Formula::parse("C6H12F2Cl2").unwrap();
        assert_eq!(formula.dbe(), -1.0);
    }

    #[test]
    fn calculates_heteroatom_ratios() {
        let formula = Formula::parse("C6H12O6").unwrap();
        let ratios = formula.heteroatom_ratios();
        assert_eq!(ratios.h_to_c, 12.0 / 6.0);
        assert_eq!(ratios.o_to_c, 6.0 / 6.0);
    }
}

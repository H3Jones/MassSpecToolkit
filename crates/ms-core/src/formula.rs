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

    fn data(&self) -> &'static IsotopeData {
        isotope_data(self.isotope).expect("Atom is created only from a valid isotope")
    }

    pub fn symbol(&self) -> &'static str {
        self.data().symbol
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
    pub count: u32,
}

impl std::fmt::Display for AtomCount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.atom)?;
        if self.count != 1 {
            write!(f, "{}", self.count)?;
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

impl Formula {
    pub(crate) fn from_atom_counts(atom_counts: Vec<AtomCount>) -> Self {
        Self { atom_counts }
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
}

impl std::fmt::Display for Formula {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for atom_count in &self.atom_counts {
            write!(f, "{}", atom_count)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}

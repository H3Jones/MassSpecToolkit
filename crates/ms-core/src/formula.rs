use crate::{
    isotopes::{IsotopeId, isotope_data},
    parser::{self, FormulaParseError},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Atom {
    pub isotope: IsotopeId,
    pub count: u32,
    pub isotope_was_specified: bool,
}

/// Returns a string representation of an isotope, including its mass number and symbol.
/// i.e. "^13C" for carbon-13.
fn isotope_representation(symbol: &str, mass_number: u16) -> String {
    format!("^{mass_number}{symbol}")
}

impl std::fmt::Display for Atom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let isotope = isotope_data(self.isotope).ok_or(std::fmt::Error)?;
        if self.isotope_was_specified {
            write!(
                f,
                "{}",
                isotope_representation(isotope.symbol, self.isotope.mass_number)
            )?;
        } else {
            write!(f, "{}", isotope.symbol)?;
        }
        if self.count != 1 {
            write!(f, "{}", self.count)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Formula {
    atoms: Vec<Atom>,
}

impl Formula {
    pub(crate) fn from_atoms(atoms: Vec<Atom>) -> Self {
        Self { atoms }
    }

    pub fn parse(input: &str) -> Result<Self, FormulaParseError> {
        parser::parse_formula(input)
    }

    pub fn atoms(&self) -> &[Atom] {
        &self.atoms
    }
}

impl std::fmt::Display for Formula {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for atom in &self.atoms {
            write!(f, "{}", atom)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_isotope_notation_and_non_unit_counts() {
        let carbon_13 = Atom {
            isotope: IsotopeId {
                atomic_number: 6,
                mass_number: 13,
            },
            count: 1,
            isotope_was_specified: true,
        };
        let oxygen_16 = Atom {
            isotope: IsotopeId {
                atomic_number: 8,
                mass_number: 16,
            },
            count: 2,
            isotope_was_specified: true,
        };

        assert_eq!(carbon_13.to_string(), "^13C");
        assert_eq!(oxygen_16.to_string(), "^16O2");
    }

    #[test]
    fn displays_formula_atoms_consecutively() {
        let formula = Formula::parse("^13CH2O").unwrap();
        assert_eq!(formula.to_string(), "^13CH2O");
    }
}

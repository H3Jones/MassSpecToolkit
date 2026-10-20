/// Module for handling ions in mass spectrometry
///
use crate::formula::Formula;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Charge {
    Positive(u8),
    Negative(u8),
    Neutral,
}

impl TryFrom<i32> for Charge {
    type Error = &'static str;

    fn try_from(charge: i32) -> Result<Self, Self::Error> {
        match charge {
            0 => Ok(Self::Neutral),
            charge if charge > 0 => u8::try_from(charge)
                .map(Self::Positive)
                .map_err(|_| "charge magnitude cannot exceed 255"),
            charge => u8::try_from(charge.unsigned_abs())
                .map(Self::Negative)
                .map_err(|_| "charge magnitude cannot exceed 255"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Ion {
    formula: Formula,
    charge: Charge,
}

impl Ion {
    pub fn new(formula: Formula, charge: Charge) -> Self {
        Self { formula, charge }
    }

    pub fn formula(&self) -> &Formula {
        &self.formula
    }

    pub fn charge(&self) -> &Charge {
        &self.charge
    }

    pub fn mass(&self) -> f64 {
        let base_mass = self.formula.mass();
        match &self.charge {
            Charge::Positive(z) => base_mass - (*z as f64 * crate::ELECTRON_MASS),
            Charge::Negative(z) => base_mass + (*z as f64 * crate::ELECTRON_MASS),
            Charge::Neutral => base_mass,
        }
    }

    pub fn mass_to_charge(&self) -> f64 {
        match &self.charge {
            Charge::Positive(z) => self.mass() / (*z as f64),
            Charge::Negative(z) => self.mass() / (*z as f64),
            Charge::Neutral => self.mass(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::H2O_MASS;

    #[test]
    fn converts_signed_values_to_charge_types() {
        assert!(matches!(Charge::try_from(2), Ok(Charge::Positive(2))));
        assert!(matches!(Charge::try_from(-2), Ok(Charge::Negative(2))));
        assert!(matches!(Charge::try_from(0), Ok(Charge::Neutral)));
    }

    #[test]
    fn rejects_charge_magnitudes_above_supported_range() {
        assert!(Charge::try_from(256).is_err());
        assert!(Charge::try_from(-256).is_err());
        assert!(Charge::try_from(i32::MIN).is_err());
    }

    #[test]
    fn test_ion_mass() {
        let formula = Formula::parse("H2O").unwrap();
        let ion = Ion::new(formula, Charge::Positive(1));
        assert_eq!(ion.mass(), H2O_MASS - crate::ELECTRON_MASS);
    }

    #[test]
    fn test_mass_to_charge() {
        let formula = Formula::parse("H2O").unwrap();
        let ion = Ion::new(formula, Charge::Positive(1));
        assert_eq!(
            ion.mass_to_charge(),
            (H2O_MASS - crate::ELECTRON_MASS) / 1.0
        );
    }
}

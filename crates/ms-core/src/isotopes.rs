use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct IsotopeId {
    /// Number of protons, uniquely identifies the element
    pub atomic_number: u8,
    /// Total number of protons and neutrons in the nucleus
    pub mass_number: u16,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IsotopeData {
    pub id: IsotopeId,
    pub symbol: &'static str,
    pub relative_atomic_mass: f64,
    pub isotopic_abundance: Option<f64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ElementData {
    pub symbol: &'static str,
    pub atomic_number: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MostAbundantIsotope {
    pub symbol: &'static str,
    pub isotope: IsotopeId,
}

include!(concat!(env!("OUT_DIR"), "/isotopes_generated.rs"));

pub fn isotope_data(id: IsotopeId) -> Option<&'static IsotopeData> {
    ISOTOPES
        .binary_search_by_key(&id, |isotope| isotope.id)
        .ok()
        .map(|index| &ISOTOPES[index])
}

pub fn atomic_number_for_symbol(symbol: &str) -> Option<u8> {
    ELEMENTS
        .binary_search_by(|element| element.symbol.cmp(symbol))
        .ok()
        .map(|index| ELEMENTS[index].atomic_number)
}

pub fn most_abundant_isotope(symbol: &str) -> Option<IsotopeId> {
    MOST_ABUNDANT_ISOTOPES
        .binary_search_by(|entry| entry.symbol.cmp(symbol))
        .ok()
        .map(|index| MOST_ABUNDANT_ISOTOPES[index].isotope)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::C_12_MASS;

    #[test]
    fn isotope_table_contains_common_isotopes() {
        let carbon_12 = isotope_data(IsotopeId {
            atomic_number: 6,
            mass_number: 12,
        })
        .expect("12C should be in the isotope table");
        assert_eq!(carbon_12.symbol, "C");
        assert_eq!(carbon_12.relative_atomic_mass, C_12_MASS);

        assert!(
            isotope_data(IsotopeId {
                atomic_number: 6,
                mass_number: 13,
            })
            .is_some()
        );
        assert_eq!(
            most_abundant_isotope("O"),
            Some(IsotopeId {
                atomic_number: 8,
                mass_number: 16,
            })
        );
    }
}

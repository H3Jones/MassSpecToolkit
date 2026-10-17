use std::{collections::HashMap, error::Error, fmt};

use pest::Parser;
use pest_derive::Parser;

use crate::{
    formula::{Atom, AtomCount, Formula},
    isotopes::{IsotopeId, atomic_number_for_symbol, isotope_data, most_abundant_isotope},
};

#[derive(Parser)]
#[grammar = "src/formula.pest"]
struct FormulaParser;

#[derive(Debug)]
pub enum FormulaParseError {
    Syntax(pest::error::Error<Rule>),
    UnknownElement { symbol: String },
    NoMostAbundantIsotope { symbol: String },
    UnknownIsotope { symbol: String, mass_number: u16 },
    InvalidIsotopeNumber(String),
    InvalidAtomCount(String),
    CountOverflow { symbol: String },
}

impl fmt::Display for FormulaParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(error) => write!(f, "invalid formula syntax: {error}"),
            Self::UnknownElement { symbol } => write!(f, "unknown element symbol {symbol}"),
            Self::NoMostAbundantIsotope { symbol } => {
                write!(f, "no most-abundant isotope is available for {symbol}")
            }
            Self::UnknownIsotope {
                symbol,
                mass_number,
            } => write!(
                f,
                "isotope {mass_number}{symbol} is not in the isotope table"
            ),
            Self::InvalidIsotopeNumber(value) => {
                write!(
                    f,
                    "isotope mass number {value} is outside the supported range"
                )
            }
            Self::InvalidAtomCount(value) => {
                write!(f, "atom count {value} is outside the supported range")
            }
            Self::CountOverflow { symbol } => {
                write!(
                    f,
                    "combined atom count for {symbol} exceeds the supported range"
                )
            }
        }
    }
}

impl Error for FormulaParseError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Syntax(error) => Some(error),
            _ => None,
        }
    }
}

pub fn parse_formula(input: &str) -> Result<Formula, FormulaParseError> {
    let mut parsed =
        FormulaParser::parse(Rule::formula, input).map_err(FormulaParseError::Syntax)?;
    let formula_pair = parsed.next().ok_or_else(|| {
        FormulaParseError::Syntax(pest::error::Error::new_from_pos(
            pest::error::ErrorVariant::CustomError {
                message: "formula was empty".to_owned(),
            },
            pest::Position::new(input, 0).expect("zero is a valid input position"),
        ))
    })?;

    let mut expanded_atoms: Vec<ParsedAtom> = Vec::new();
    for component in formula_pair.into_inner() {
        if component.as_rule() == Rule::component {
            append_component(component, &mut expanded_atoms)?;
        }
    }

    let mut parsed_atoms: Vec<ParsedAtom> = Vec::new();
    let mut atom_indices: HashMap<(String, Option<u16>), usize> = HashMap::new();
    for parsed_atom in expanded_atoms {
        let key = (parsed_atom.symbol.clone(), parsed_atom.mass_number);
        if let Some(&index) = atom_indices.get(&key) {
            parsed_atoms[index].count = parsed_atoms[index]
                .count
                .checked_add(parsed_atom.count)
                .ok_or_else(|| FormulaParseError::CountOverflow {
                    symbol: parsed_atom.symbol.clone(),
                })?;
        } else {
            atom_indices.insert(key, parsed_atoms.len());
            parsed_atoms.push(parsed_atom);
        }
    }

    let mut atoms = Vec::with_capacity(parsed_atoms.len());
    let mut atomic_numbers = HashMap::new();
    for parsed_atom in parsed_atoms {
        let isotope_was_specified = parsed_atom.mass_number.is_some();
        let isotope = match parsed_atom.mass_number {
            Some(mass_number) => {
                let atomic_number = cached_atomic_number(&parsed_atom.symbol, &mut atomic_numbers)
                    .ok_or_else(|| FormulaParseError::UnknownElement {
                        symbol: parsed_atom.symbol.clone(),
                    })?;
                let id = IsotopeId {
                    atomic_number,
                    mass_number,
                };
                if isotope_data(id).is_none() {
                    return Err(FormulaParseError::UnknownIsotope {
                        symbol: parsed_atom.symbol,
                        mass_number,
                    });
                }
                id
            }
            None => most_abundant_isotope(&parsed_atom.symbol).ok_or_else(|| {
                if cached_atomic_number(&parsed_atom.symbol, &mut atomic_numbers).is_some() {
                    FormulaParseError::NoMostAbundantIsotope {
                        symbol: parsed_atom.symbol.clone(),
                    }
                } else {
                    FormulaParseError::UnknownElement {
                        symbol: parsed_atom.symbol.clone(),
                    }
                }
            })?,
        };

        atoms.push(AtomCount {
            atom: Atom::from_isotope_id(isotope, isotope_was_specified),
            count: parsed_atom.count,
        });
    }

    Formula::from_atom_counts(atoms)
}

fn append_component(
    component: pest::iterators::Pair<'_, Rule>,
    atoms: &mut Vec<ParsedAtom>,
) -> Result<(), FormulaParseError> {
    let inner = component
        .into_inner()
        .next()
        .expect("component is not empty");
    match inner.as_rule() {
        Rule::atom_count => {
            let mut symbol = None;
            let mut mass_number = None;
            let mut count = 1;
            for part in inner.into_inner() {
                match part.as_rule() {
                    Rule::isotope => {
                        let value = part.as_str().trim_start_matches('^');
                        mass_number = Some(value.parse::<u16>().map_err(|_| {
                            FormulaParseError::InvalidIsotopeNumber(value.to_owned())
                        })?);
                    }
                    Rule::element => symbol = Some(part.as_str()),
                    Rule::number => count = parse_count(part.as_str())?,
                    _ => unreachable!("grammar only produces isotope, element, and number here"),
                }
            }

            atoms.push(ParsedAtom {
                symbol: symbol
                    .expect("each atom_count contains an element")
                    .to_owned(),
                mass_number,
                count,
            });
        }
        Rule::group => {
            let mut group_atoms = Vec::new();
            let mut multiplier = 1;
            for part in inner.into_inner() {
                match part.as_rule() {
                    Rule::component => append_component(part, &mut group_atoms)?,
                    Rule::number => multiplier = parse_count(part.as_str())?,
                    _ => unreachable!("grammar only produces components and a number in a group"),
                }
            }
            for atom in &mut group_atoms {
                atom.count = atom.count.checked_mul(multiplier).ok_or_else(|| {
                    FormulaParseError::CountOverflow {
                        symbol: atom.symbol.clone(),
                    }
                })?;
            }
            atoms.extend(group_atoms);
        }
        _ => unreachable!("grammar only produces groups and atom counts in a component"),
    }
    Ok(())
}

fn parse_count(value: &str) -> Result<i32, FormulaParseError> {
    let count = value
        .parse::<i32>()
        .map_err(|_| FormulaParseError::InvalidAtomCount(value.to_owned()))?;
    if count == 0 {
        return Err(FormulaParseError::InvalidAtomCount(value.to_owned()));
    }
    Ok(count)
}

struct ParsedAtom {
    symbol: String,
    mass_number: Option<u16>,
    count: i32,
}

fn cached_atomic_number(symbol: &str, cache: &mut HashMap<String, Option<u8>>) -> Option<u8> {
    *cache
        .entry(symbol.to_owned())
        .or_insert_with(|| atomic_number_for_symbol(symbol))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_unspecified_isotopes_to_most_abundant() {
        let formula = parse_formula("C6H12O6").unwrap();
        let atom_counts = formula.atom_counts();
        assert_eq!(atom_counts.len(), 3);
        assert_eq!(atom_counts[0].atom.symbol(), "C");
        assert_eq!(atom_counts[0].atom.mass_number(), 12);
        assert_eq!(atom_counts[0].count, 6);
        assert!(!atom_counts[0].atom.isotope_was_specified());
        assert_eq!(atom_counts[1].atom.symbol(), "H");
        assert_eq!(atom_counts[1].atom.mass_number(), 1);
        assert_eq!(atom_counts[1].count, 12);
        assert_eq!(atom_counts[2].atom.symbol(), "O");
        assert_eq!(atom_counts[2].atom.mass_number(), 16);
        assert_eq!(atom_counts[2].count, 6);
    }

    #[test]
    fn resolves_explicit_isotopes_and_defaults_other_elements() {
        let formula = Formula::parse("^13CH2O").unwrap();
        assert_eq!(formula.atom_counts()[0].atom.mass_number(), 13);
        assert_eq!(formula.atom_counts()[0].count, 1);
        assert!(formula.atom_counts()[0].atom.isotope_was_specified());
        assert_eq!(formula.atom_counts()[1].atom.mass_number(), 1);
        assert_eq!(formula.atom_counts()[1].count, 2);
        assert!(!formula.atom_counts()[1].atom.isotope_was_specified());
        assert_eq!(formula.atom_counts()[2].atom.mass_number(), 16);
    }

    #[test]
    fn rejects_unknown_isotopes_and_malformed_formulas() {
        assert!(matches!(
            parse_formula("^999C"),
            Err(FormulaParseError::UnknownIsotope {
                symbol,
                mass_number: 999
            }) if symbol == "C"
        ));
        assert!(matches!(
            parse_formula("C-2"),
            Err(FormulaParseError::Syntax(_))
        ));
        assert!(matches!(
            parse_formula("Qq"),
            Err(FormulaParseError::UnknownElement { symbol }) if symbol == "Qq"
        ));
    }

    #[test]
    fn resolves_repeated_elements() {
        let formula = Formula::parse("CH3C2H2CH2CH2").unwrap();
        assert_eq!(formula.atom_counts().len(), 2);
        assert_eq!(formula.atom_counts()[0].atom.symbol(), "C");
        assert_eq!(formula.atom_counts()[0].count, 5);
        assert_eq!(formula.atom_counts()[1].atom.symbol(), "H");
        assert_eq!(formula.atom_counts()[1].count, 9);
    }

    #[test]
    fn expands_parenthesized_groups() {
        let formula = Formula::parse("C2(OH)2").unwrap();
        assert_eq!(formula.atom_counts().len(), 3);
        assert_eq!(formula.atom_counts()[0].atom.symbol(), "C");
        assert_eq!(formula.atom_counts()[0].count, 2);
        assert_eq!(formula.atom_counts()[1].atom.symbol(), "O");
        assert_eq!(formula.atom_counts()[1].count, 2);
        assert_eq!(formula.atom_counts()[2].atom.symbol(), "H");
        assert_eq!(formula.atom_counts()[2].count, 2);
    }

    #[test]
    fn expands_nested_groups_and_rejects_invalid_group_counts() {
        let formula = Formula::parse("C(OH2)2").unwrap();
        assert_eq!(formula.atom_counts()[1].count, 2);
        assert_eq!(formula.atom_counts()[2].count, 4);
        assert!(matches!(
            Formula::parse("(OH)0"),
            Err(FormulaParseError::InvalidAtomCount(value)) if value == "0"
        ));
        assert!(matches!(
            Formula::parse("(C2147483647)2"),
            Err(FormulaParseError::CountOverflow { symbol }) if symbol == "C"
        ));
    }

    #[test]
    fn combines_repeated_terms_within_each_isotope_selection() {
        let formula = Formula::parse("C^13C2C").unwrap();
        assert_eq!(formula.atom_counts().len(), 2);
        assert_eq!(formula.atom_counts()[0].count, 2);
        assert!(!formula.atom_counts()[0].atom.isotope_was_specified());
        assert_eq!(formula.atom_counts()[1].count, 2);
        assert!(formula.atom_counts()[1].atom.isotope_was_specified());
    }

    #[test]
    fn reports_overflow_when_combining_counts() {
        assert!(matches!(
            Formula::parse("C2147483647C"),
            Err(FormulaParseError::CountOverflow { symbol }) if symbol == "C"
        ));
    }

    #[test]
    fn rejects_zero_and_out_of_range_atom_counts() {
        assert!(matches!(
            Formula::parse("C0"),
            Err(FormulaParseError::InvalidAtomCount(value)) if value == "0"
        ));
        assert!(matches!(
            Formula::parse("C2147483648"),
            Err(FormulaParseError::InvalidAtomCount(value)) if value == "2147483648"
        ));
    }
}

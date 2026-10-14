use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, ErrorKind},
    path::PathBuf,
};

use toml::Value;

type BuildResult<T> = Result<T, Box<dyn std::error::Error>>;

struct Isotope {
    atomic_number: u8,
    mass_number: u16,
    symbol: String,
    relative_atomic_mass: Option<f64>,
    isotopic_abundance: Option<f64>,
}

fn main() {
    println!("cargo:rerun-if-changed=assets/isotopes.toml");
    if let Err(error) = generate_isotope_table() {
        panic!("failed to generate isotope table: {error}");
    }
}

fn generate_isotope_table() -> BuildResult<()> {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"));
    let source = fs::read_to_string(manifest_dir.join("assets/isotopes.toml"))?;
    let document: Value = source.parse()?;
    let isotope_tables = document
        .get("isotopes")
        .and_then(Value::as_table)
        .ok_or_else(|| invalid_data("missing [isotopes] table"))?;

    let mut isotopes = Vec::with_capacity(isotope_tables.len());
    let mut isotope_ids = BTreeSet::new();
    let mut elements = BTreeMap::new();
    for (key, value) in isotope_tables {
        let table = value
            .as_table()
            .ok_or_else(|| invalid_data(format!("isotope {key} is not a table")))?;
        let id = required_string(table, "id", key)?;
        if id != key {
            return Err(invalid_data(format!(
                "isotope table key {key} does not match its id {id}"
            ))
            .into());
        }

        let atomic_number = u8::try_from(required_integer(table, "atomic_number", key)?)?;
        let neutron_number = required_integer(table, "neutron_number", key)?;
        let mass_number = atomic_number as u16 + neutron_number;
        if !isotope_ids.insert((atomic_number, mass_number)) {
            return Err(invalid_data(format!(
                "duplicate isotope with atomic number {atomic_number} and mass number {mass_number}"
            ))
            .into());
        }

        let symbol = required_string(table, "symbol", key)?.to_owned();
        if let Some(previous_atomic_number) = elements.insert(symbol.clone(), atomic_number)
            && previous_atomic_number != atomic_number {
                return Err(invalid_data(format!(
                    "element symbol {symbol} maps to multiple atomic numbers"
                ))
                .into());
            }

        isotopes.push(Isotope {
            atomic_number,
            mass_number,
            symbol,
            relative_atomic_mass: optional_float(table, "relative_atomic_mass", key)?,
            isotopic_abundance: optional_float(table, "isotopic_abundance", key)?,
        });
    }
    isotopes.sort_unstable_by_key(|isotope| (isotope.atomic_number, isotope.mass_number));

    let common = document
        .get("common")
        .and_then(Value::as_table)
        .ok_or_else(|| invalid_data("missing [common] table"))?;
    let most_abundant_tables = common
        .get("most_abundant")
        .and_then(Value::as_table)
        .ok_or_else(|| invalid_data("missing [common.most_abundant] table"))?;
    let mut most_abundant = Vec::with_capacity(most_abundant_tables.len());
    for (symbol, isotope_key) in most_abundant_tables {
        let isotope_key = isotope_key.as_str().ok_or_else(|| {
            invalid_data(format!(
                "most-abundant isotope for {symbol} is not a string"
            ))
        })?;
        let table = isotope_tables
            .get(isotope_key)
            .and_then(Value::as_table)
            .ok_or_else(|| invalid_data(format!("unknown most-abundant isotope {isotope_key}")))?;
        let atomic_number = u8::try_from(required_integer(table, "atomic_number", isotope_key)?)?;
        let neutron_number = required_integer(table, "neutron_number", isotope_key)?;
        most_abundant.push((
            symbol.clone(),
            atomic_number,
            atomic_number as u16 + neutron_number,
        ));
    }
    most_abundant.sort_unstable_by(|left, right| left.0.cmp(&right.0));

    let mut generated = String::new();
    generated.push_str(&format!(
        "pub static ISOTOPES: [IsotopeData; {}] = [\n",
        isotopes.len()
    ));
    for isotope in isotopes {
        generated.push_str(&format!(
            "    IsotopeData {{ id: IsotopeId {{ atomic_number: {}, mass_number: {} }}, symbol: {:?}, relative_atomic_mass: {}, isotopic_abundance: {} }},\n",
            isotope.atomic_number,
            isotope.mass_number,
            isotope.symbol,
            float_option(isotope.relative_atomic_mass),
            float_option(isotope.isotopic_abundance),
        ));
    }
    generated.push_str("];\n\n");

    generated.push_str(&format!(
        "pub static ELEMENTS: [ElementData; {}] = [\n",
        elements.len()
    ));
    for (symbol, atomic_number) in elements {
        generated.push_str(&format!(
            "    ElementData {{ symbol: {symbol:?}, atomic_number: {atomic_number} }},\n"
        ));
    }
    generated.push_str("];\n\n");

    generated.push_str(&format!(
        "pub static MOST_ABUNDANT_ISOTOPES: [MostAbundantIsotope; {}] = [\n",
        most_abundant.len()
    ));
    for (symbol, atomic_number, mass_number) in most_abundant {
        generated.push_str(&format!(
            "    MostAbundantIsotope {{ symbol: {:?}, isotope: IsotopeId {{ atomic_number: {atomic_number}, mass_number: {mass_number} }} }},\n",
            symbol,
        ));
    }
    generated.push_str("];\n");

    let output_path = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set"))
        .join("isotopes_generated.rs");
    fs::write(output_path, generated)?;
    Ok(())
}

fn required_integer(
    table: &toml::map::Map<String, Value>,
    field: &str,
    isotope: &str,
) -> BuildResult<u16> {
    let value = table
        .get(field)
        .and_then(Value::as_integer)
        .ok_or_else(|| invalid_data(format!("isotope {isotope} has no integer {field}")))?;
    Ok(u16::try_from(value)?)
}

fn required_string<'a>(
    table: &'a toml::map::Map<String, Value>,
    field: &str,
    isotope: &str,
) -> BuildResult<&'a str> {
    table
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_data(format!("isotope {isotope} has no string {field}")).into())
}

fn optional_float(
    table: &toml::map::Map<String, Value>,
    field: &str,
    isotope: &str,
) -> BuildResult<Option<f64>> {
    match table.get(field) {
        None => Ok(None),
        Some(value) => value
            .as_float()
            .or_else(|| value.as_integer().map(|integer| integer as f64))
            .map(Some)
            .ok_or_else(|| invalid_data(format!("isotope {isotope} has invalid {field}")).into()),
    }
}

fn float_option(value: Option<f64>) -> String {
    match value {
        Some(value) => format!("Some({value:?})"),
        None => "None".to_owned(),
    }
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, message.into())
}

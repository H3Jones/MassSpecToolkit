pub mod assignment;
pub mod formula;
pub mod ion;
pub mod isotopes;
pub mod parser;
pub mod spectrum;

pub const ELECTRON_MASS: f64 = 0.000548579909065; // in atomic mass units (u)

const MILLI_DALTON: f64 = 1e-3; // in atomic mass units (u)

#[cfg(test)]
mod test_support;

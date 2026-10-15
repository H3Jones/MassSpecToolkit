pub mod formula;
pub mod isotopes;
pub mod parser;
pub mod ion;

const ELECTRON_MASS: f64 = 0.000548579909065; // in atomic mass units (u)

#[cfg(test)]
mod test_support;
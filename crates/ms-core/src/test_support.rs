pub(crate) const C_12_MASS: f64 = 12.0;
pub(crate) const C_13_MASS: f64 = 13.00335483507;
pub(crate) const H_1_MASS: f64 = 1.00782503223;
pub(crate) const O_16_MASS: f64 = 15.99491461957;

// Precomputed masses for common molecules.
pub(crate) const H2O_MASS: f64 = 2.0 * H_1_MASS + O_16_MASS;
pub(crate) const C6H6O6_MASS: f64 = 6.0 * C_12_MASS + 6.0 * H_1_MASS + 6.0 * O_16_MASS;

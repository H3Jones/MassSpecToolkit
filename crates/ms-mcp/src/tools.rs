use crate::api::{self, ToleranceUnit};
use rmcp::{
    ServerHandler, handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool,
    tool_handler, tool_router,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct EvaluateIonArgs {
    /// Molecular formula, for example C6H12O6 or ^13CH4.
    formula: String,
    /// Signed charge; use 0 for a neutral molecule.
    charge: i32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct MassSplitArgs {
    /// First molecular formula.
    formula_a: String,
    /// Second molecular formula.
    formula_b: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
enum McpToleranceUnit {
    Ppm,
    Da,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AssignPeakArgs {
    /// Observed m/z, or neutral mass when charge is zero.
    observed_mz: f64,
    /// Nonnegative tolerance in the selected unit.
    tolerance: f64,
    /// Tolerance unit.
    tolerance_unit: McpToleranceUnit,
    /// Signed charge; use 0 for a neutral mass.
    charge: i32,
    /// Comma- or whitespace-separated count ranges, such as C4-100,H8-200,O2-30.
    element_ranges: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct FineIsotopeDistributionArgs {
    /// Molecular formula, for example C2H6O.
    formula: String,
    /// Signed charge; use 0 for a neutral molecule.
    charge: i32,
    /// Required retained probability in (0, 1], for example 0.9999.
    coverage: f64,
}

#[derive(Clone)]
pub(crate) struct MassSpectrometrist;

#[tool_router]
impl MassSpectrometrist {
    #[tool(
        description = "Calculate a formula's exact mass, DBE, atom counts, and mass-to-charge ratio for a signed charge. No adducts are added."
    )]
    fn evaluate_ion(&self, Parameters(args): Parameters<EvaluateIonArgs>) -> CallToolResult {
        structured_result(api::evaluate_ion(&args.formula, args.charge))
    }

    #[tool(
        description = "Compare two molecular formulas and return their formula-specific components and signed mass difference."
    )]
    fn mass_split(&self, Parameters(args): Parameters<MassSplitArgs>) -> CallToolResult {
        structured_result(api::mass_split(&args.formula_a, &args.formula_b))
    }

    #[tool(
        description = "Assign formulas to one observed m/z using a signed charge, tolerance, and element count ranges. Search is bounded to 100,000 count combinations and 1,000 matches; narrow the ranges or tolerance if a bound is exceeded. Formulas describe the complete ion composition; no adducts are added."
    )]
    fn assign_peak(&self, Parameters(args): Parameters<AssignPeakArgs>) -> CallToolResult {
        let tolerance_unit = match args.tolerance_unit {
            McpToleranceUnit::Ppm => ToleranceUnit::Ppm,
            McpToleranceUnit::Da => ToleranceUnit::Da,
        };
        structured_result(api::assign_peak(
            args.observed_mz,
            args.tolerance,
            tolerance_unit,
            args.charge,
            &args.element_ranges,
        ))
    }

    #[tool(
        description = "Calculate a fine-structure isotope distribution with electron-mass correction for the supplied signed charge. The calculation is limited to 300 atoms and 20,000 states; errors are returned if the requested coverage cannot be reached."
    )]
    fn fine_isotope_distribution(
        &self,
        Parameters(args): Parameters<FineIsotopeDistributionArgs>,
    ) -> CallToolResult {
        structured_result(api::fine_isotope_distribution(
            &args.formula,
            args.charge,
            args.coverage,
        ))
    }
}

#[tool_handler(
    name = "mass-spec-toolkit",
    version = "0.1.0",
    instructions = "Mass spectrometry calculations backed by the MassSpecToolkit Rust core."
)]
impl ServerHandler for MassSpectrometrist {}

fn structured_result<T: Serialize>(result: Result<T, String>) -> CallToolResult {
    match result {
        Ok(value) => match serde_json::to_value(value) {
            Ok(value) => CallToolResult::structured(value),
            Err(error) => tool_error(format!("failed to serialize calculation result: {error}")),
        },
        Err(error) => tool_error(error),
    }
}

fn tool_error(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![rmcp::model::ContentBlock::text(message)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculation_results_are_returned_as_structured_content() {
        let result = structured_result(api::evaluate_ion("H2O", 1));
        let content = result.structured_content.unwrap();
        assert_eq!(content["formula"], "H2O");
        assert_eq!(content["charge"], 1);
        assert!(content["mass"].is_number());
    }
}

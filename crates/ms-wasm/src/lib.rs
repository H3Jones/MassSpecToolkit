use ms_core::assignment::{ElementRange, MassTolerance, assign_mass};
use ms_core::formula::{Formula, sort_by_hill_order};
use ms_core::ion::{Charge, Ion};
use ms_core::isotopes::{
    FineIsotopeDistributionOptions, IsotopeDistributionError,
    fine_isotope_distribution as calculate_fine_isotope_distribution, isotope_data,
};
use ms_core::parser::parse_element_ranges as parse_ranges;
use ms_core::spectrum::{
    MassSpectrum, SpectrumMetadata as CoreSpectrumMetadata, SpectrumType as CoreSpectrumType,
};
use ms_core::{ELECTRON_MASS, isotopes::IsotopeId};
use ms_readers::readers::txt::{
    self, TxtDelimiter as ReaderTxtDelimiter, TxtFormat as ReaderTxtFormat,
};
use serde::{Deserialize, Serialize};
use tsify::{Ts, Tsify};
use wasm_bindgen::JsError;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Tsify)]
pub struct FormulaResult {
    formula: String,
    mass: f64,
    dbe: f64,
    atom_counts: Vec<AtomCount>,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct IonResult {
    formula: String,
    charge: i32,
    mass: f64,
    dbe: f64,
    mass_to_charge: Option<f64>,
    atom_counts: Vec<AtomCount>,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct MassSplitResult {
    formula_a: FormulaResult,
    formula_b: FormulaResult,
    formula_a_only: Option<FormulaResult>,
    formula_b_only: Option<FormulaResult>,
    mass_difference: f64,
}

#[derive(Serialize, Tsify)]
pub struct ElementRangeResult {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    min: i32,
    max: i32,
}

#[derive(Serialize, Tsify)]
pub struct ElementRangesResult {
    ranges: Vec<ElementRangeResult>,
}

#[derive(Clone, Copy, Serialize, Tsify)]
#[serde(rename_all = "lowercase")]
pub enum MassToleranceUnit {
    Ppm,
    Da,
}

#[derive(Serialize, Tsify)]
pub struct PeakAssignmentMatchResult {
    formula: String,
    charge: i32,
    mass: f64,
    mass_to_charge: f64,
    error_da: f64,
    error_ppm: f64,
}

#[derive(Serialize, Tsify)]
pub struct PeakAssignmentResult {
    observed_mz: f64,
    tolerance: f64,
    tolerance_unit: MassToleranceUnit,
    charges: Vec<i32>,
    element_ranges: Vec<ElementRangeResult>,
    matches: Vec<PeakAssignmentMatchResult>,
}

#[derive(Serialize, Tsify)]
pub struct FineIsotopePeakResult {
    label: String,
    mass: f64,
    mass_to_charge: Option<f64>,
    abundance: f64,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct FineIsotopeDistributionResult {
    charge: i32,
    retained_probability: f64,
    peaks: Vec<FineIsotopePeakResult>,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct SpectrumPeakResult {
    mz: f64,
    intensity: f64,
    signal_to_noise: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    retention_time: Option<f64>,
}

#[derive(Serialize, Tsify)]
#[tsify(missing_as_null)]
pub struct MassSpectrumResult {
    peaks: Vec<SpectrumPeakResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    metadata: Option<SpectrumMetadata>,
}

#[derive(Serialize, Tsify)]
pub enum SpectrumType {
    Direct,
    Hyphenated,
}

#[derive(Serialize, Tsify)]
#[serde(rename_all = "camelCase")]
#[tsify(missing_as_null)]
pub struct SpectrumMetadata {
    filename: String,
    #[serde(rename = "type")]
    spectrum_type: SpectrumType,
    peak_count: usize,
    minimum_mz: f64,
    maximum_mz: f64,
    minimum_intensity: f64,
    maximum_intensity: f64,
    minimum_retention_time: Option<f64>,
    maximum_retention_time: Option<f64>,
}

impl From<CoreSpectrumMetadata> for SpectrumMetadata {
    fn from(metadata: CoreSpectrumMetadata) -> Self {
        Self {
            filename: metadata.filename,
            spectrum_type: match metadata.spectrum_type {
                CoreSpectrumType::Direct => SpectrumType::Direct,
                CoreSpectrumType::Hyphenated => SpectrumType::Hyphenated,
            },
            peak_count: metadata.peak_count,
            minimum_mz: metadata.minimum_mz,
            maximum_mz: metadata.maximum_mz,
            minimum_intensity: metadata.minimum_intensity,
            maximum_intensity: metadata.maximum_intensity,
            minimum_retention_time: metadata.minimum_retention_time,
            maximum_retention_time: metadata.maximum_retention_time,
        }
    }
}

#[derive(Serialize, Deserialize, Tsify)]
#[serde(rename_all = "snake_case")]
pub enum TxtDelimiter {
    Whitespace,
    Character(char),
}

/// Text layout with zero-based column indices and a physical-line skip count.
#[derive(Serialize, Deserialize, Tsify)]
#[tsify(missing_as_null)]
pub struct TxtFormat {
    delimiter: TxtDelimiter,
    skip_lines: usize,
    column_count: usize,
    mz_column: usize,
    intensity_column: usize,
    signal_to_noise_column: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[tsify(optional)]
    retention_time_column: Option<usize>,
}

impl From<ReaderTxtFormat> for TxtFormat {
    fn from(spec: ReaderTxtFormat) -> Self {
        Self {
            delimiter: match spec.delimiter {
                ReaderTxtDelimiter::Whitespace => TxtDelimiter::Whitespace,
                ReaderTxtDelimiter::Character(value) => TxtDelimiter::Character(value),
            },
            skip_lines: spec.skip_lines,
            column_count: spec.column_count,
            mz_column: spec.mz_column,
            intensity_column: spec.intensity_column,
            signal_to_noise_column: spec.signal_to_noise_column,
            retention_time_column: spec.retention_time_column,
        }
    }
}

impl From<TxtFormat> for ReaderTxtFormat {
    fn from(spec: TxtFormat) -> Self {
        Self {
            delimiter: match spec.delimiter {
                TxtDelimiter::Whitespace => ReaderTxtDelimiter::Whitespace,
                TxtDelimiter::Character(value) => ReaderTxtDelimiter::Character(value),
            },
            skip_lines: spec.skip_lines,
            column_count: spec.column_count,
            mz_column: spec.mz_column,
            intensity_column: spec.intensity_column,
            signal_to_noise_column: spec.signal_to_noise_column,
            retention_time_column: spec.retention_time_column,
        }
    }
}

#[derive(Serialize, Tsify)]
struct AtomCount {
    symbol: &'static str,
    mass_number: u16,
    isotope_was_specified: bool,
    atom_ram: f64,
    count: i32,
    total_mass: f64,
}

/// Parses a chemical formula and returns its normalized form, mass, and atom counts.
#[wasm_bindgen]
pub fn parse_formula(input: &str) -> Result<Ts<FormulaResult>, JsError> {
    let formula = Formula::parse(input).map_err(|error| JsError::new(&error.to_string()))?;
    let result = formula_result(&formula);

    Ok(result.into_ts()?)
}

/// Guesses a text layout from up to 32 lines, without assuming unlabeled S/N.
#[wasm_bindgen]
pub fn guess_txt_format(input: &str) -> Result<Ts<TxtFormat>, JsError> {
    let spec: TxtFormat = txt::guess_txt_format(input.as_bytes())
        .map_err(|error| JsError::new(&error.to_string()))?
        .into();
    Ok(spec.into_ts()?)
}

/// Reads text peaks with an explicit layout, or guesses one if omitted.
/// Peak order, duplicate m/z values, and original intensities are preserved.
/// A filename requests full-file metadata for nonempty spectra; string-only calls are unchanged.
#[wasm_bindgen]
pub fn parse_txt(
    input: &str,
    spec: Option<Ts<TxtFormat>>,
    filename: Option<String>,
) -> Result<Ts<MassSpectrumResult>, JsError> {
    let spectrum = read_txt_spectrum(input, spec)?;
    let result = MassSpectrumResult {
        metadata: filename
            .and_then(|name| spectrum.metadata(name))
            .map(Into::into),
        peaks: spectrum
            .peaks()
            .iter()
            .map(|peak| SpectrumPeakResult {
                mz: peak.mz(),
                intensity: peak.intensity(),
                signal_to_noise: peak.signal_to_noise(),
                retention_time: peak.retention_time(),
            })
            .collect(),
    };
    Ok(result.into_ts()?)
}

fn read_txt_spectrum(input: &str, spec: Option<Ts<TxtFormat>>) -> Result<MassSpectrum, JsError> {
    let spec = if let Some(spec) = spec {
        spec.to_rust()?.into()
    } else {
        txt::guess_txt_format(input.as_bytes()).map_err(|error| JsError::new(&error.to_string()))?
    };
    txt::read(input.as_bytes(), &spec).map_err(|error| JsError::new(&error.to_string()))
}

/// An owned, transferable columnar batch. Validity bytes distinguish missing values from zero.
#[wasm_bindgen(getter_with_clone)]
pub struct SpectrumPeakBatch {
    #[wasm_bindgen(readonly)]
    pub start_index: usize,
    #[wasm_bindgen(readonly)]
    pub mz: Vec<f64>,
    #[wasm_bindgen(readonly)]
    pub intensity: Vec<f64>,
    #[wasm_bindgen(readonly)]
    pub signal_to_noise: Vec<f64>,
    #[wasm_bindgen(readonly)]
    pub signal_to_noise_validity: Vec<u8>,
    #[wasm_bindgen(readonly)]
    pub retention_time: Vec<f64>,
    #[wasm_bindgen(readonly)]
    pub retention_time_validity: Vec<u8>,
}

/// Retains the full Rust spectrum, but exposes at most 16,384 rows at a time to JavaScript.
#[wasm_bindgen]
pub struct TxtSpectrumReader {
    spectrum: MassSpectrum,
    metadata: CoreSpectrumMetadata,
    next_index: usize,
}

#[wasm_bindgen]
impl TxtSpectrumReader {
    #[wasm_bindgen(constructor)]
    pub fn new(
        input: &str,
        spec: Option<Ts<TxtFormat>>,
        filename: String,
    ) -> Result<TxtSpectrumReader, JsError> {
        let spectrum = read_txt_spectrum(input, spec)?;
        let metadata = spectrum
            .metadata(filename)
            .ok_or_else(|| JsError::new("The file contains no peaks."))?;
        Ok(Self {
            spectrum,
            metadata,
            next_index: 0,
        })
    }

    pub fn metadata(&self) -> Result<Ts<SpectrumMetadata>, JsError> {
        Ok(SpectrumMetadata::from(self.metadata.clone()).into_ts()?)
    }

    pub fn next_batch(&mut self) -> Option<SpectrumPeakBatch> {
        let start = self.next_index;
        if start == self.spectrum.peaks().len() {
            return None;
        }
        let end = (start + 16_384).min(self.spectrum.peaks().len());
        let count = end - start;
        let mut batch = SpectrumPeakBatch {
            start_index: start,
            mz: Vec::with_capacity(count),
            intensity: Vec::with_capacity(count),
            signal_to_noise: Vec::with_capacity(count),
            signal_to_noise_validity: Vec::with_capacity(count),
            retention_time: Vec::with_capacity(count),
            retention_time_validity: Vec::with_capacity(count),
        };
        for peak in &self.spectrum.peaks()[start..end] {
            batch.mz.push(peak.mz());
            batch.intensity.push(peak.intensity());
            batch
                .signal_to_noise
                .push(peak.signal_to_noise().unwrap_or_default());
            batch
                .signal_to_noise_validity
                .push(u8::from(peak.signal_to_noise().is_some()));
            batch
                .retention_time
                .push(peak.retention_time().unwrap_or_default());
            batch
                .retention_time_validity
                .push(u8::from(peak.retention_time().is_some()));
        }
        self.next_index = end;
        Some(batch)
    }
}

/// Parses a comma- or whitespace-separated range list for display before assignment.
#[wasm_bindgen]
pub fn parse_element_ranges(input: &str) -> Result<Ts<ElementRangesResult>, JsError> {
    let ranges = parse_ranges(input).map_err(|error| JsError::new(&error.to_string()))?;
    let result = ElementRangesResult {
        ranges: ranges.iter().map(element_range_result).collect(),
    };
    Ok(result.into_ts()?)
}

/// Assigns one measured m/z over an inclusive signed charge range, excluding zero.
/// Formulas describe the complete ion composition; no adducts are added.
/// Errors are experimental minus theoretical; ppm errors and tolerances use theoretical m/z.
#[wasm_bindgen]
pub fn assign_peak(
    observed_mz: f64,
    tolerance: f64,
    tolerance_unit: &str,
    charge_min: f64,
    charge_max: f64,
    element_ranges: &str,
) -> Result<Ts<PeakAssignmentResult>, JsError> {
    for charge in [charge_min, charge_max] {
        if !charge.is_finite() || charge.fract() != 0.0 || !(-255.0..=255.0).contains(&charge) {
            return Err(JsError::new(
                "charge bounds must be integers between -255 and 255",
            ));
        }
    }
    if charge_min > charge_max {
        return Err(JsError::new(
            "minimum charge must not exceed maximum charge",
        ));
    }
    let charges: Vec<_> = (charge_min as i32..=charge_max as i32)
        .filter(|charge| *charge != 0)
        .collect();
    if charges.is_empty() {
        return Err(JsError::new(
            "charge range must include at least one nonzero charge",
        ));
    }
    let (mass_tolerance, tolerance_unit) = match tolerance_unit {
        "ppm" => (MassTolerance::Ppm(tolerance), MassToleranceUnit::Ppm),
        "da" => (MassTolerance::Da(tolerance), MassToleranceUnit::Da),
        _ => return Err(JsError::new("tolerance unit must be ppm or da")),
    };
    let ranges = parse_ranges(element_ranges).map_err(|error| JsError::new(&error.to_string()))?;
    let mut matches = Vec::new();
    for &charge in &charges {
        let charge_type = Charge::try_from(charge).map_err(JsError::new)?;
        let assignments = assign_mass(observed_mz, charge_type, &ranges, mass_tolerance)
            .map_err(|error| JsError::new(&error.to_string()))?;
        matches.extend(
            assignments
                .into_iter()
                .map(|hit| PeakAssignmentMatchResult {
                    formula: hit.ion().formula().to_string(),
                    charge,
                    mass: hit.ion().mass(),
                    mass_to_charge: hit.calculated_mz(),
                    error_da: hit.error_da(),
                    error_ppm: hit.error_ppm(),
                }),
        );
    }
    matches.sort_by(|a, b| {
        a.error_da
            .abs()
            .total_cmp(&b.error_da.abs())
            .then_with(|| a.formula.cmp(&b.formula))
            .then_with(|| a.charge.cmp(&b.charge))
    });
    let result = PeakAssignmentResult {
        observed_mz,
        tolerance,
        tolerance_unit,
        charges,
        element_ranges: ranges.iter().map(element_range_result).collect(),
        matches,
    };
    Ok(result.into_ts()?)
}

/// Evaluates a formula with a signed charge and returns its mass and, for ions, mass-to-charge ratio.
#[wasm_bindgen]
pub fn evaluate_ion(input: &str, charge: i32) -> Result<Ts<IonResult>, JsError> {
    let charge_type = Charge::try_from(charge).map_err(JsError::new)?;
    let formula = Formula::parse(input).map_err(|error| JsError::new(&error.to_string()))?;
    let ion = Ion::new(formula, charge_type);
    let formula_result = formula_result(ion.formula());
    let result = IonResult {
        formula: formula_result.formula,
        charge,
        mass: ion.mass(),
        dbe: formula_result.dbe,
        mass_to_charge: (charge != 0).then(|| ion.mass_to_charge()),
        atom_counts: formula_result.atom_counts,
    };

    Ok(result.into_ts()?)
}

/// Calculates a fine-structure isotope distribution and applies electron-mass correction for charge.
#[wasm_bindgen]
pub fn fine_isotope_distribution(
    input: &str,
    charge: i32,
) -> Result<Ts<FineIsotopeDistributionResult>, JsError> {
    Charge::try_from(charge).map_err(JsError::new)?;
    let formula = Formula::parse(input).map_err(|error| JsError::new(&error.to_string()))?;
    let mut distribution = None;
    let mut state_limit_error = None;
    for coverage in [1.0, 0.9999, 0.999, 0.99] {
        match calculate_fine_isotope_distribution(
            &formula,
            FineIsotopeDistributionOptions {
                coverage,
                ..FineIsotopeDistributionOptions::default()
            },
        ) {
            Ok(result) => {
                distribution = Some(result);
                break;
            }
            Err(error @ IsotopeDistributionError::StateLimitExceeded { .. }) => {
                state_limit_error = Some(error);
            }
            Err(error) => return Err(JsError::new(&error.to_string())),
        }
    }
    let distribution = match (distribution, state_limit_error) {
        (Some(result), _) => result,
        (None, Some(error)) => return Err(JsError::new(&error.to_string())),
        (None, None) => return Err(JsError::new("no isotope coverage targets configured")),
    };
    let peaks = distribution
        .peaks
        .into_iter()
        .map(|mut peak| {
            sort_by_hill_order(&mut peak.composition);
            let label = peak
                .composition
                .iter()
                .map(|entry| {
                    let isotope = isotope_data(IsotopeId {
                        atomic_number: entry.isotope.atomic_number,
                        mass_number: entry.isotope.mass_number,
                    })
                    .expect("isotope compositions only contain known isotope ids");
                    if entry.count == 1 {
                        isotope.isotope_symbol()
                    } else {
                        format!("{}{}", isotope.isotope_symbol(), entry.count)
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let mass = peak.mass - f64::from(charge) * ELECTRON_MASS;
            FineIsotopePeakResult {
                label,
                mass,
                mass_to_charge: (charge != 0).then(|| mass / f64::from(charge.unsigned_abs())),
                abundance: peak.abundance,
            }
        })
        .collect();
    let result = FineIsotopeDistributionResult {
        charge,
        retained_probability: distribution.retained_probability,
        peaks,
    };

    Ok(result.into_ts()?)
}

/// Compares two formulas and returns their formula-specific components and signed mass difference.
#[wasm_bindgen]
pub fn mass_split(formula_a: &str, formula_b: &str) -> Result<Ts<MassSplitResult>, JsError> {
    let formula_a = Formula::parse(formula_a).map_err(|error| JsError::new(&error.to_string()))?;
    let formula_b = Formula::parse(formula_b).map_err(|error| JsError::new(&error.to_string()))?;
    let difference = formula_a.difference(&formula_b);
    let mass_difference = match difference.mass() {
        mass if mass == 0.0 => 0.0,
        mass => mass,
    };
    let (formula_b_only, formula_a_only) = difference.as_split();
    let result = MassSplitResult {
        formula_a: formula_result(&formula_a),
        formula_b: formula_result(&formula_b),
        formula_a_only: formula_a_only.as_ref().map(formula_result),
        formula_b_only: formula_b_only.as_ref().map(formula_result),
        mass_difference,
    };

    Ok(result.into_ts()?)
}

fn element_range_result(range: &ElementRange) -> ElementRangeResult {
    ElementRangeResult {
        symbol: range.symbol(),
        mass_number: range.atom().mass_number(),
        isotope_was_specified: range.atom().isotope_was_specified(),
        min: range.min(),
        max: range.max(),
    }
}

fn formula_result(formula: &Formula) -> FormulaResult {
    FormulaResult {
        formula: formula.to_string(),
        mass: formula.mass(),
        atom_counts: formula
            .atom_counts()
            .iter()
            .map(|atom_count| AtomCount {
                symbol: atom_count.atom.symbol(),
                mass_number: atom_count.atom.mass_number(),
                isotope_was_specified: atom_count.atom.isotope_was_specified(),
                atom_ram: atom_count.atom.relative_atomic_mass(),
                count: atom_count.count,
                total_mass: atom_count.mass(),
            })
            .collect(),
        dbe: formula.dbe(),
    }
}

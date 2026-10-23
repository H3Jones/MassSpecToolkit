//! Measured centroid spectra and their candidate mass assignments.
//!
//! Intensities retain their original scale; they are not isotope probabilities.
//! Spectrum constructors preserve input order and duplicate m/z values.
//!
//! ```
//! use ms_core::{
//!     assignment::{ElementRange, MassTolerance, assign_mass},
//!     ion::Charge,
//!     spectrum::{AnnotatedMassSpectrum, AnnotatedPeak, MassSpectrum, Peak},
//! };
//!
//! let peak = Peak::new(180.06284, 1250.0, Some(20.0))?;
//! let spectrum = MassSpectrum::new(vec![peak]);
//! let ranges = ["C6", "H12", "O6"]
//!     .map(|range| ElementRange::parse(range).unwrap());
//! let assignments = assign_mass(
//!     peak.mz(), Charge::Positive(1), &ranges, MassTolerance::Ppm(5.0),
//! )?;
//! let annotated_peak = AnnotatedPeak::new(peak, assignments)?;
//! let annotated = AnnotatedMassSpectrum::new(vec![annotated_peak]);
//!
//! assert_eq!(spectrum.peaks()[0].intensity(), 1250.0);
//! assert_eq!(annotated.peaks()[0].assignments().len(), 1);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use crate::assignment::MassAssignment;

/// A measured centroid peak, independent of any chemical assignment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Peak {
    mz: f64,
    intensity: f64,
    signal_to_noise: Option<f64>,
    retention_time: Option<f64>,
}

impl Peak {
    /// Creates a peak with finite, strictly positive m/z.
    ///
    /// Intensity and S/N, when supplied, must be finite and nonnegative.
    /// Unlike chart input, zero m/z is rejected to match mass assignment input.
    pub fn new(
        mz: f64,
        intensity: f64,
        signal_to_noise: Option<f64>,
    ) -> Result<Self, SpectrumError> {
        if !mz.is_finite() || mz <= 0.0 {
            return Err(SpectrumError::InvalidMz);
        }
        if !intensity.is_finite() || intensity < 0.0 {
            return Err(SpectrumError::InvalidIntensity);
        }
        if signal_to_noise.is_some_and(|value| !value.is_finite() || value < 0.0) {
            return Err(SpectrumError::InvalidSignalToNoise);
        }
        Ok(Self {
            mz,
            intensity,
            signal_to_noise,
            retention_time: None,
        })
    }

    /// Attaches a finite, nonnegative retention time in the original input units.
    pub fn with_retention_time(mut self, retention_time: f64) -> Result<Self, SpectrumError> {
        if !retention_time.is_finite() || retention_time < 0.0 {
            return Err(SpectrumError::InvalidRetentionTime);
        }
        self.retention_time = Some(retention_time);
        Ok(self)
    }

    pub fn retention_time(&self) -> Option<f64> {
        self.retention_time
    }

    pub fn mz(&self) -> f64 {
        self.mz
    }

    /// Returns the original intensity, without normalization.
    pub fn intensity(&self) -> f64 {
        self.intensity
    }

    /// Returns S/N when available; `None` does not imply zero.
    pub fn signal_to_noise(&self) -> Option<f64> {
        self.signal_to_noise
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpectrumType {
    Direct,
    Hyphenated,
}

/// Full-file bounds in original measurement units, independent of any filtered view.
#[derive(Clone, Debug, PartialEq)]
pub struct SpectrumMetadata {
    pub filename: String,
    pub spectrum_type: SpectrumType,
    pub peak_count: usize,
    pub minimum_mz: f64,
    pub maximum_mz: f64,
    pub minimum_intensity: f64,
    pub maximum_intensity: f64,
    pub minimum_retention_time: Option<f64>,
    pub maximum_retention_time: Option<f64>,
}

/// An unannotated centroid spectrum, which may be empty.
#[derive(Clone, Debug, PartialEq)]
pub struct MassSpectrum {
    peaks: Vec<Peak>,
}

impl MassSpectrum {
    /// Keeps every peak in input order, without sorting, merging, or normalization.
    pub fn new(peaks: Vec<Peak>) -> Self {
        Self { peaks }
    }

    pub fn peaks(&self) -> &[Peak] {
        &self.peaks
    }

    /// Empty spectra have no bounds. Any measured RT, including zero, is hyphenated data.
    pub fn metadata(&self, filename: impl Into<String>) -> Option<SpectrumMetadata> {
        let first = self.peaks.first()?;
        let mut metadata = SpectrumMetadata {
            filename: filename.into(),
            spectrum_type: SpectrumType::Direct,
            peak_count: self.peaks.len(),
            minimum_mz: first.mz(),
            maximum_mz: first.mz(),
            minimum_intensity: first.intensity(),
            maximum_intensity: first.intensity(),
            minimum_retention_time: None,
            maximum_retention_time: None,
        };
        for peak in &self.peaks {
            metadata.minimum_mz = metadata.minimum_mz.min(peak.mz());
            metadata.maximum_mz = metadata.maximum_mz.max(peak.mz());
            metadata.minimum_intensity = metadata.minimum_intensity.min(peak.intensity());
            metadata.maximum_intensity = metadata.maximum_intensity.max(peak.intensity());
            if let Some(rt) = peak.retention_time() {
                metadata.spectrum_type = SpectrumType::Hyphenated;
                metadata.minimum_retention_time = Some(
                    metadata
                        .minimum_retention_time
                        .map_or(rt, |min| min.min(rt)),
                );
                metadata.maximum_retention_time = Some(
                    metadata
                        .maximum_retention_time
                        .map_or(rt, |max| max.max(rt)),
                );
            }
        }
        Some(metadata)
    }
}

/// A measured peak and zero or more candidate chemical assignments.
#[derive(Clone, Debug)]
pub struct AnnotatedPeak {
    peak: Peak,
    assignments: Vec<MassAssignment>,
}

impl AnnotatedPeak {
    /// Requires every assignment's observed m/z to equal the peak's m/z exactly.
    ///
    /// Construct assignments using [`Peak::mz`]; no tolerance is applied when
    /// linking measurements. An empty list preserves an unassigned peak.
    /// Candidate order is preserved; mass errors are provided by [`MassAssignment`].
    pub fn new(peak: Peak, assignments: Vec<MassAssignment>) -> Result<Self, SpectrumError> {
        if let Some(index) = assignments
            .iter()
            .position(|assignment| assignment.observed_mz() != peak.mz())
        {
            return Err(SpectrumError::AssignmentMzMismatch { index });
        }
        Ok(Self { peak, assignments })
    }

    pub fn peak(&self) -> &Peak {
        &self.peak
    }

    pub fn assignments(&self) -> &[MassAssignment] {
        &self.assignments
    }
}

/// A centroid spectrum retaining both assigned and unassigned peaks.
#[derive(Clone, Debug)]
pub struct AnnotatedMassSpectrum {
    peaks: Vec<AnnotatedPeak>,
}

impl AnnotatedMassSpectrum {
    /// Keeps every peak in input order, including duplicates; an empty list is valid.
    pub fn new(peaks: Vec<AnnotatedPeak>) -> Self {
        Self { peaks }
    }

    pub fn peaks(&self) -> &[AnnotatedPeak] {
        &self.peaks
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SpectrumError {
    InvalidMz,
    InvalidIntensity,
    InvalidSignalToNoise,
    InvalidRetentionTime,
    AssignmentMzMismatch { index: usize },
}

impl std::fmt::Display for SpectrumError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidMz => write!(f, "peak m/z must be finite and greater than zero"),
            Self::InvalidIntensity => write!(f, "peak intensity must be finite and nonnegative"),
            Self::InvalidSignalToNoise => write!(f, "peak S/N must be finite and nonnegative"),
            Self::InvalidRetentionTime => {
                write!(f, "peak retention time must be finite and nonnegative")
            }
            Self::AssignmentMzMismatch { index } => write!(
                f,
                "assignment at index {index} has an observed m/z different from the peak m/z"
            ),
        }
    }
}

impl std::error::Error for SpectrumError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        assignment::{ElementRange, MassTolerance, assign_mass},
        formula::Formula,
        ion::{Charge, Ion},
    };

    fn assignment(formula: &str, observed_mz: f64) -> MassAssignment {
        MassAssignment::new(
            Ion::new(Formula::parse(formula).unwrap(), Charge::Positive(1)),
            observed_mz,
        )
        .unwrap()
    }

    #[test]
    fn preserves_measurements_and_optional_signal_to_noise() {
        let peak = Peak::new(180.06284, 1250.0, Some(20.0)).unwrap();
        assert_eq!(peak.mz(), 180.06284);
        assert_eq!(peak.intensity(), 1250.0);
        assert_eq!(peak.signal_to_noise(), Some(20.0));

        let unknown_noise = Peak::new(1.0, 0.0, None).unwrap();
        let zero_noise = Peak::new(1.0, 0.0, Some(0.0)).unwrap();
        assert_eq!(unknown_noise.signal_to_noise(), None);
        assert_eq!(zero_noise.signal_to_noise(), Some(0.0));
        assert_ne!(unknown_noise, zero_noise);
    }

    #[test]
    fn metadata_describes_the_full_direct_spectrum() {
        let spectrum = MassSpectrum::new(vec![
            Peak::new(57.0, 250.0, None).unwrap(),
            Peak::new(43.0, 1000.0, None).unwrap(),
            Peak::new(57.0, 0.0, None).unwrap(),
        ]);
        assert_eq!(
            spectrum.metadata("direct.asc"),
            Some(SpectrumMetadata {
                filename: "direct.asc".into(),
                spectrum_type: SpectrumType::Direct,
                peak_count: 3,
                minimum_mz: 43.0,
                maximum_mz: 57.0,
                minimum_intensity: 0.0,
                maximum_intensity: 1000.0,
                minimum_retention_time: None,
                maximum_retention_time: None,
            })
        );
        assert_eq!(MassSpectrum::new(vec![]).metadata("empty.asc"), None);
    }

    #[test]
    fn metadata_classifies_zero_and_single_retention_times_as_hyphenated() {
        let peak = Peak::new(43.0, 100.0, None).unwrap();
        let spectrum = MassSpectrum::new(vec![peak.with_retention_time(0.0).unwrap()]);
        let metadata = spectrum.metadata("zero.csv").unwrap();
        assert_eq!(metadata.spectrum_type, SpectrumType::Hyphenated);
        assert_eq!(metadata.minimum_retention_time, Some(0.0));
        assert_eq!(metadata.maximum_retention_time, Some(0.0));

        let spectrum = MassSpectrum::new(vec![
            peak,
            peak.with_retention_time(2.5).unwrap(),
            peak.with_retention_time(2.4).unwrap(),
        ]);
        let metadata = spectrum.metadata("gc.csv").unwrap();
        assert_eq!(metadata.peak_count, 3);
        assert_eq!(metadata.minimum_retention_time, Some(2.4));
        assert_eq!(metadata.maximum_retention_time, Some(2.5));
    }

    #[test]
    fn validates_optional_retention_time() {
        let peak = Peak::new(43.0, 100.0, None).unwrap();
        assert_eq!(peak.retention_time(), None);
        assert_eq!(
            peak.with_retention_time(0.0).unwrap().retention_time(),
            Some(0.0)
        );
        for value in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                peak.with_retention_time(value),
                Err(SpectrumError::InvalidRetentionTime)
            );
        }
    }

    #[test]
    fn rejects_nonpositive_and_nonfinite_mz() {
        for mz in [0.0, -0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(Peak::new(mz, 1.0, None), Err(SpectrumError::InvalidMz));
        }
    }

    #[test]
    fn rejects_negative_and_nonfinite_intensity() {
        for intensity in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                Peak::new(1.0, intensity, None),
                Err(SpectrumError::InvalidIntensity)
            );
        }
    }

    #[test]
    fn rejects_negative_and_nonfinite_signal_to_noise() {
        for signal_to_noise in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                Peak::new(1.0, 1.0, Some(signal_to_noise)),
                Err(SpectrumError::InvalidSignalToNoise)
            );
        }
    }

    #[test]
    fn accepts_finite_measurements_without_arbitrary_upper_or_lower_cutoffs() {
        for value in [f64::from_bits(1), f64::MIN_POSITIVE, f64::MAX] {
            let peak = Peak::new(value, value, Some(value)).unwrap();
            assert_eq!(peak.mz(), value);
            assert_eq!(peak.intensity(), value);
            assert_eq!(peak.signal_to_noise(), Some(value));
        }
    }

    #[test]
    fn preserves_unannotated_peak_order_duplicates_and_intensities() {
        let first = Peak::new(200.0, 500.0, None).unwrap();
        let second = Peak::new(100.0, 250.0, Some(10.0)).unwrap();
        let peaks = vec![first, second, first];
        let spectrum = MassSpectrum::new(peaks.clone());
        assert_eq!(spectrum.peaks(), peaks);
        assert_eq!(spectrum.clone(), spectrum);
        assert!(MassSpectrum::new(vec![]).peaks().is_empty());
    }

    #[test]
    fn retains_multiple_assignment_candidates_in_input_order() {
        let peak = Peak::new(18.01, 500.0, None).unwrap();
        let assignments = vec![assignment("H2O", peak.mz()), assignment("CH4", peak.mz())];
        let errors: Vec<_> = assignments
            .iter()
            .map(|candidate| (candidate.error_da(), candidate.error_ppm()))
            .collect();
        let annotated = AnnotatedPeak::new(peak, assignments).unwrap();
        assert_eq!(annotated.peak(), &peak);
        assert_eq!(annotated.assignments().len(), 2);
        for (candidate, expected) in annotated.assignments().iter().zip(errors) {
            assert_eq!(candidate.observed_mz(), peak.mz());
            assert_eq!((candidate.error_da(), candidate.error_ppm()), expected);
        }
        assert_eq!(
            annotated.assignments()[0].ion().formula().to_string(),
            "H2O"
        );
        assert_eq!(
            annotated.assignments()[1].ion().formula().to_string(),
            "CH4"
        );
    }

    #[test]
    fn rejects_even_adjacent_mz_values_and_reports_the_mismatched_index() {
        let peak = Peak::new(18.01, 500.0, None).unwrap();
        let adjacent_mz = f64::from_bits(peak.mz().to_bits() + 1);
        for assignments in [
            vec![assignment("H2O", adjacent_mz)],
            vec![assignment("H2O", peak.mz()), assignment("CH4", adjacent_mz)],
        ] {
            let index = assignments.len() - 1;
            assert_eq!(
                AnnotatedPeak::new(peak, assignments).unwrap_err(),
                SpectrumError::AssignmentMzMismatch { index }
            );
        }
    }

    #[test]
    fn accepts_assignments_from_the_existing_mass_search() {
        let ion = Ion::new(Formula::parse("H2O").unwrap(), Charge::Positive(1));
        let peak = Peak::new(ion.mass_to_charge(), 100.0, None).unwrap();
        let ranges = ["H2", "O1"].map(|range| ElementRange::parse(range).unwrap());
        let assignments = assign_mass(
            peak.mz(),
            Charge::Positive(1),
            &ranges,
            MassTolerance::Da(0.0),
        )
        .unwrap();
        let annotated = AnnotatedPeak::new(peak, assignments).unwrap();
        assert_eq!(annotated.assignments().len(), 1);
        assert_eq!(annotated.assignments()[0].error_da(), 0.0);
    }

    #[test]
    fn preserves_assigned_unassigned_and_duplicate_peaks_in_order() {
        let peak = Peak::new(18.01, 500.0, None).unwrap();
        let other_peak = Peak::new(10.0, 250.0, Some(10.0)).unwrap();
        let assigned = AnnotatedPeak::new(peak, vec![assignment("H2O", peak.mz())]).unwrap();
        let unassigned = AnnotatedPeak::new(other_peak, vec![]).unwrap();
        let spectrum = AnnotatedMassSpectrum::new(vec![assigned.clone(), unassigned, assigned]);
        let cloned = spectrum.clone();
        let peaks = cloned.peaks();
        assert_eq!(peaks.len(), 3);
        assert_eq!(*peaks[0].peak(), peak);
        assert_eq!(*peaks[1].peak(), other_peak);
        assert_eq!(*peaks[2].peak(), peak);
        assert_eq!(peaks[0].assignments().len(), 1);
        assert!(peaks[1].assignments().is_empty());
        assert_eq!(peaks[2].assignments().len(), 1);
        assert!(AnnotatedMassSpectrum::new(vec![]).peaks().is_empty());
    }

    #[test]
    fn exposes_descriptive_errors() {
        let cases = [
            (
                SpectrumError::InvalidMz,
                "peak m/z must be finite and greater than zero",
            ),
            (
                SpectrumError::InvalidIntensity,
                "peak intensity must be finite and nonnegative",
            ),
            (
                SpectrumError::InvalidSignalToNoise,
                "peak S/N must be finite and nonnegative",
            ),
            (
                SpectrumError::AssignmentMzMismatch { index: 2 },
                "assignment at index 2 has an observed m/z different from the peak m/z",
            ),
        ];
        for (error, expected) in cases {
            let error: &dyn std::error::Error = &error;
            assert_eq!(error.to_string(), expected);
        }
    }
}

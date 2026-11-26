//! Canonical measured data: a [`Run`] of peaks, optionally grouped into scans.
//!
//! Flat exports such as CSV peak lists carry one RT per peak and no scan
//! boundaries. Scan-structured sources such as mzML attach RT and acquisition
//! metadata to each scan. Either way peaks are stored once, in shared columns;
//! scans address them through offsets, matching the Arrow list layout.
//!
//! RT and MS-level selections choose whole rows or scans. m/z and intensity
//! slices filter peaks, retaining all scans, including empty ones. Selections
//! always return another [`Run`] with the same source metadata.
//! Repeated RT values are never interpreted as scan boundaries.
//!
//! ```
//! use ms_core::run::{PeakColumns, RtUnitMetadata, Run, ScanColumns, SourceInfo};
//!
//! let source = SourceInfo {
//!     source_id: "example".into(),
//!     filename: "example.mzML".into(),
//!     reader_format: "synthetic".into(),
//!     rt_unit: Some(RtUnitMetadata::resolve(None, None)?),
//! };
//! let scans = ScanColumns {
//!     index: vec![0, 1],
//!     native_id: vec!["scan=1".into(), "scan=2".into()],
//!     ms_level: vec![1, 2],
//!     rt: vec![Some(5.5), Some(6.0)],
//!     polarity: vec![None, None],
//!     representation: vec![None, None],
//!     peak_offsets: vec![0, 2, 3],
//! };
//! let peaks = PeakColumns {
//!     mz: vec![100.0, 200.0, 150.0],
//!     intensity: vec![10.0, 20.0, 5.0],
//!     rt: None,
//!     signal_to_noise: None,
//! };
//! let run = Run::with_scans(source, scans, peaks)?;
//! let selected = run.get_rt_slice(5.5, 5.5)?;
//! let spectrum = selected.spectra().next().unwrap();
//! assert_eq!(spectrum.native_id(), "scan=1");
//! assert_eq!(spectrum.mz(), &[100.0, 200.0]);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use std::{collections::HashSet, fmt, ops::Range, str::FromStr};

use crate::spectrum::{Peak, SpectrumError};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RtUnit {
    Seconds,
    Minutes,
    Milliseconds,
}

impl RtUnit {
    pub fn to_seconds(self, value: f64) -> Result<f64, RtUnitError> {
        if !value.is_finite() || value < 0.0 {
            return Err(RtUnitError::InvalidRetentionTime);
        }
        let seconds = match self {
            Self::Seconds => value,
            Self::Minutes => value * 60.0,
            Self::Milliseconds => value / 1000.0,
        };
        if !seconds.is_finite() {
            return Err(RtUnitError::ConversionOverflow);
        }
        Ok(seconds)
    }
}

impl FromStr for RtUnit {
    type Err = RtUnitError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "seconds" => Ok(Self::Seconds),
            "minutes" => Ok(Self::Minutes),
            "milliseconds" => Ok(Self::Milliseconds),
            _ => Err(RtUnitError::UnsupportedUnit(value.to_owned())),
        }
    }
}

impl fmt::Display for RtUnit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Seconds => "seconds",
            Self::Minutes => "minutes",
            Self::Milliseconds => "milliseconds",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RtUnitOrigin {
    Declared,
    Caller,
    Default,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RtUnitMetadata {
    input_unit: RtUnit,
    declared_unit: Option<RtUnit>,
    origin: RtUnitOrigin,
}

impl RtUnitMetadata {
    /// Uses a declaration or caller unit, defaulting undeclared input to seconds.
    /// A caller confirming a declaration leaves its origin as `Declared`.
    pub fn resolve(declared: Option<RtUnit>, caller: Option<RtUnit>) -> Result<Self, RtUnitError> {
        if let (Some(declared), Some(caller)) = (declared, caller)
            && declared != caller
        {
            return Err(RtUnitError::ConflictingUnits { declared, caller });
        }
        let (input_unit, origin) = match (declared, caller) {
            (Some(unit), _) => (unit, RtUnitOrigin::Declared),
            (None, Some(unit)) => (unit, RtUnitOrigin::Caller),
            (None, None) => (RtUnit::Seconds, RtUnitOrigin::Default),
        };
        Ok(Self {
            input_unit,
            declared_unit: declared,
            origin,
        })
    }

    pub fn input_unit(&self) -> RtUnit {
        self.input_unit
    }

    pub fn declared_unit(&self) -> Option<RtUnit> {
        self.declared_unit
    }

    pub fn origin(&self) -> RtUnitOrigin {
        self.origin
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RtUnitError {
    UnsupportedUnit(String),
    InvalidRetentionTime,
    ConversionOverflow,
    ConflictingUnits { declared: RtUnit, caller: RtUnit },
}

impl fmt::Display for RtUnitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedUnit(unit) => write!(f, "unsupported RT unit: {unit:?}"),
            Self::InvalidRetentionTime => {
                f.write_str("retention time must be finite and nonnegative")
            }
            Self::ConversionOverflow => f.write_str("retention time conversion overflowed seconds"),
            Self::ConflictingUnits { declared, caller } => write!(
                f,
                "declared RT unit {declared} conflicts with caller unit {caller}"
            ),
        }
    }
}

impl std::error::Error for RtUnitError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Polarity {
    Positive,
    Negative,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Representation {
    Centroid,
    Profile,
}

/// Whether RT and identity belong to individual peaks or to scans.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunLayout {
    Flat,
    Scans,
}

/// Optional column presence, which survives empty runs and selections.
/// `has_rt` is always true for scan runs; RT values are always seconds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunSchema {
    pub layout: RunLayout,
    pub has_rt: bool,
    pub has_signal_to_noise: bool,
}

/// The reader assigns source identity; selections preserve this metadata.
/// `rt_unit` describes input RT values and is required exactly when RT exists.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceInfo {
    pub source_id: String,
    pub filename: String,
    pub reader_format: String,
    pub rt_unit: Option<RtUnitMetadata>,
}

/// Peak-level columns. Input RT values use the source unit; a run exposes seconds.
/// Per-peak RT is only valid for flat runs; scan runs record RT per scan.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PeakColumns {
    pub mz: Vec<f64>,
    pub intensity: Vec<f64>,
    pub rt: Option<Vec<Option<f64>>>,
    pub signal_to_noise: Option<Vec<Option<f64>>>,
}

/// Scan-level columns. Scan `i` owns peaks `peak_offsets[i]..peak_offsets[i + 1]`.
///
/// `index` and `native_id` are source identities (for mzML, the spectrum index
/// and `id` attribute) and are preserved by selections.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ScanColumns {
    pub index: Vec<u64>,
    pub native_id: Vec<String>,
    pub ms_level: Vec<u8>,
    pub rt: Vec<Option<f64>>,
    pub polarity: Vec<Option<Polarity>>,
    pub representation: Vec<Option<Representation>>,
    pub peak_offsets: Vec<usize>,
}

/// Validated scan metadata with RT in seconds.
#[derive(Clone, Debug, PartialEq)]
pub struct ScanTable(ScanColumns);

impl ScanTable {
    pub fn len(&self) -> usize {
        self.0.index.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.index.is_empty()
    }

    pub fn index(&self) -> &[u64] {
        &self.0.index
    }

    pub fn native_id(&self) -> &[String] {
        &self.0.native_id
    }

    pub fn ms_level(&self) -> &[u8] {
        &self.0.ms_level
    }

    pub fn rt(&self) -> &[Option<f64>] {
        &self.0.rt
    }

    pub fn polarity(&self) -> &[Option<Polarity>] {
        &self.0.polarity
    }

    pub fn representation(&self) -> &[Option<Representation>] {
        &self.0.representation
    }

    pub fn peak_offsets(&self) -> &[usize] {
        &self.0.peak_offsets
    }

    /// Panics if `scan` is out of bounds.
    pub fn peak_range(&self, scan: usize) -> Range<usize> {
        self.0.peak_offsets[scan]..self.0.peak_offsets[scan + 1]
    }
}

/// Statistics for the current run, not necessarily its entire source.
#[derive(Clone, Debug, PartialEq)]
pub struct RunSummary {
    pub peak_count: usize,
    pub scan_count: Option<usize>,
    pub mz_bounds: Option<(f64, f64)>,
    pub intensity_bounds: Option<(f64, f64)>,
    pub rt_bounds: Option<(f64, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
enum Layout {
    Flat { peak_id: Vec<u64> },
    Scans(ScanTable),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Run {
    source: SourceInfo,
    peaks: PeakColumns,
    layout: Layout,
    summary: RunSummary,
}

impl Run {
    /// Builds a flat run whose rows are the selectable units.
    ///
    /// Validates column lengths, unique source-local peak IDs and measurements.
    /// IDs need not be sorted or contiguous. Input RTs are normalized to seconds once.
    pub fn flat(
        source: SourceInfo,
        peak_id: Vec<u64>,
        mut peaks: PeakColumns,
    ) -> Result<Self, RunError> {
        validate_peaks(&peaks, peak_id.len())?;
        if peaks.rt.is_some() != source.rt_unit.is_some() {
            return Err(RunError::RtUnitMetadataMismatch);
        }
        let mut identities = HashSet::with_capacity(peak_id.len());
        for (row, &id) in peak_id.iter().enumerate() {
            if !identities.insert(id) {
                return Err(RunError::DuplicatePeakId { row, peak_id: id });
            }
        }
        if let (Some(values), Some(unit)) = (&mut peaks.rt, source.rt_unit) {
            normalize_rt(values, unit.input_unit())
                .map_err(|(row, source)| RunError::InvalidRt { row, source })?;
        }
        Ok(Self::assemble(source, peaks, Layout::Flat { peak_id }))
    }

    /// Builds a scan run whose scans are the selectable units.
    ///
    /// Offsets must start at zero, never decrease and end at the peak count;
    /// scans may be empty. Scan indices and native IDs must be unique, MS levels
    /// at least one, and peaks must not carry their own RT. Source RT unit
    /// metadata is required because scans always have an RT column.
    pub fn with_scans(
        source: SourceInfo,
        mut scans: ScanColumns,
        peaks: PeakColumns,
    ) -> Result<Self, RunError> {
        validate_peaks(&peaks, peaks.mz.len())?;
        if peaks.rt.is_some() {
            return Err(RunError::PeakRtInScanRun);
        }
        let unit = source.rt_unit.ok_or(RunError::RtUnitMetadataMismatch)?;
        let count = scans.index.len();
        let lengths = [
            ("native_id", scans.native_id.len(), count),
            ("ms_level", scans.ms_level.len(), count),
            ("scan_rt", scans.rt.len(), count),
            ("polarity", scans.polarity.len(), count),
            ("representation", scans.representation.len(), count),
            ("peak_offsets", scans.peak_offsets.len(), count + 1),
        ];
        for (column, actual, expected) in lengths {
            if actual != expected {
                return Err(RunError::ColumnLengthMismatch {
                    column,
                    expected,
                    actual,
                });
            }
        }
        if scans.peak_offsets[0] != 0 {
            return Err(RunError::InvalidPeakOffsets { scan: 0 });
        }
        for scan in 0..count {
            if scans.peak_offsets[scan + 1] < scans.peak_offsets[scan] {
                return Err(RunError::InvalidPeakOffsets { scan });
            }
        }
        if scans.peak_offsets[count] != peaks.mz.len() {
            return Err(RunError::InvalidPeakOffsets {
                scan: count.saturating_sub(1),
            });
        }
        let mut indices = HashSet::with_capacity(count);
        let mut native_ids = HashSet::with_capacity(count);
        for scan in 0..count {
            if !indices.insert(scans.index[scan]) {
                return Err(RunError::DuplicateScanIndex {
                    scan,
                    index: scans.index[scan],
                });
            }
            if !native_ids.insert(scans.native_id[scan].as_str()) {
                return Err(RunError::DuplicateNativeId { scan });
            }
            if scans.ms_level[scan] == 0 {
                return Err(RunError::InvalidMsLevel { scan });
            }
        }
        normalize_rt(&mut scans.rt, unit.input_unit())
            .map_err(|(scan, source)| RunError::InvalidScanRt { scan, source })?;
        Ok(Self::assemble(
            source,
            peaks,
            Layout::Scans(ScanTable(scans)),
        ))
    }

    fn assemble(source: SourceInfo, peaks: PeakColumns, layout: Layout) -> Self {
        let rt_bounds = match &layout {
            Layout::Flat { .. } => peaks
                .rt
                .as_ref()
                .and_then(|values| bounds(values.iter().copied().flatten())),
            Layout::Scans(scans) => bounds(scans.rt().iter().copied().flatten()),
        };
        let summary = RunSummary {
            peak_count: peaks.mz.len(),
            scan_count: match &layout {
                Layout::Flat { .. } => None,
                Layout::Scans(scans) => Some(scans.len()),
            },
            mz_bounds: bounds(peaks.mz.iter().copied()),
            intensity_bounds: bounds(peaks.intensity.iter().copied()),
            rt_bounds,
        };
        Self {
            source,
            peaks,
            layout,
            summary,
        }
    }

    /// Selects rows or whole scans with `minimum <= RT <= maximum`, in seconds.
    ///
    /// Bounds must be finite, nonnegative and ordered. Equal bounds select an
    /// exact RT. Missing RTs are excluded; a flat run without RT is an error.
    pub fn get_rt_slice(&self, minimum: f64, maximum: f64) -> Result<Self, RunError> {
        self.select_rt_range(minimum, maximum, true)
    }

    /// Selects units in the half-open seconds interval `start <= RT < end`.
    pub fn get_rt_range(&self, start: f64, end: f64) -> Result<Self, RunError> {
        self.select_rt_range(start, end, false)
    }

    fn select_rt_range(&self, start: f64, end: f64, inclusive_end: bool) -> Result<Self, RunError> {
        for value in [start, end] {
            RtUnit::Seconds
                .to_seconds(value)
                .map_err(RunError::InvalidQueryRt)?;
        }
        if start > end {
            return Err(RunError::InvalidRtRange { start, end });
        }
        let values = self.selectable_rt().ok_or(RunError::RtUnavailable)?;
        Ok(self.select(|unit| {
            values[unit].is_some_and(|rt| start <= rt && (rt < end || (inclusive_end && rt == end)))
        }))
    }

    /// Selects scans at one MS level. Flat runs have no MS levels.
    pub fn get_ms_level(&self, level: u8) -> Result<Self, RunError> {
        let Layout::Scans(scans) = &self.layout else {
            return Err(RunError::MsLevelUnavailable);
        };
        Ok(self.select(|scan| scans.ms_level()[scan] == level))
    }

    /// Retains peaks with `minimum <= m/z <= maximum`, preserving source order.
    ///
    /// Bounds must be finite, nonnegative and ordered. Scan metadata is retained
    /// even when no peaks remain in a scan; offsets and summaries are rebuilt.
    pub fn get_mz_slice(&self, minimum: f64, maximum: f64) -> Result<Self, RunError> {
        self.select_peak_range(&self.peaks.mz, "m/z", minimum, maximum)
    }

    /// Retains peaks with `minimum <= intensity <= maximum` in their original scale.
    ///
    /// Bounds must be finite, nonnegative and ordered. All scans are retained,
    /// including empty ones; flat runs preserve their source-local peak IDs.
    pub fn get_intensity_slice(&self, minimum: f64, maximum: f64) -> Result<Self, RunError> {
        self.select_peak_range(&self.peaks.intensity, "intensity", minimum, maximum)
    }

    fn select_peak_range(
        &self,
        values: &[f64],
        column: &'static str,
        minimum: f64,
        maximum: f64,
    ) -> Result<Self, RunError> {
        if !minimum.is_finite() || !maximum.is_finite() || minimum < 0.0 || maximum < minimum {
            return Err(RunError::InvalidPeakRange {
                column,
                minimum,
                maximum,
            });
        }
        Ok(self.select_peaks(|row| minimum <= values[row] && values[row] <= maximum))
    }

    fn select_peaks(&self, predicate: impl Fn(usize) -> bool) -> Self {
        match &self.layout {
            Layout::Flat { .. } => self.select(predicate),
            Layout::Scans(scans) => {
                let mut columns = scans.0.clone();
                columns.peak_offsets.clear();
                columns.peak_offsets.push(0);
                let mut rows = Vec::new();
                for scan in 0..scans.len() {
                    rows.extend(scans.peak_range(scan).filter(|&row| predicate(row)));
                    columns.peak_offsets.push(rows.len());
                }
                self.select_rows(&rows, Layout::Scans(ScanTable(columns)))
            }
        }
    }

    fn selectable_rt(&self) -> Option<&[Option<f64>]> {
        match &self.layout {
            Layout::Flat { .. } => self.peaks.rt.as_deref(),
            Layout::Scans(scans) => Some(scans.rt()),
        }
    }

    fn select(&self, predicate: impl Fn(usize) -> bool) -> Self {
        let (rows, layout) = match &self.layout {
            Layout::Flat { peak_id } => {
                let rows: Vec<_> = (0..peak_id.len()).filter(|&row| predicate(row)).collect();
                let peak_id = pick(peak_id, &rows);
                (rows, Layout::Flat { peak_id })
            }
            Layout::Scans(scans) => {
                let selected: Vec<_> = (0..scans.len()).filter(|&scan| predicate(scan)).collect();
                let mut rows = Vec::new();
                let mut peak_offsets = Vec::with_capacity(selected.len() + 1);
                peak_offsets.push(0);
                for &scan in &selected {
                    rows.extend(scans.peak_range(scan));
                    peak_offsets.push(rows.len());
                }
                let columns = &scans.0;
                let table = ScanTable(ScanColumns {
                    index: pick(&columns.index, &selected),
                    native_id: pick(&columns.native_id, &selected),
                    ms_level: pick(&columns.ms_level, &selected),
                    rt: pick(&columns.rt, &selected),
                    polarity: pick(&columns.polarity, &selected),
                    representation: pick(&columns.representation, &selected),
                    peak_offsets,
                });
                (rows, Layout::Scans(table))
            }
        };
        self.select_rows(&rows, layout)
    }

    fn select_rows(&self, rows: &[usize], layout: Layout) -> Self {
        let peaks = PeakColumns {
            mz: pick(&self.peaks.mz, rows),
            intensity: pick(&self.peaks.intensity, rows),
            rt: self.peaks.rt.as_ref().map(|values| pick(values, rows)),
            signal_to_noise: self
                .peaks
                .signal_to_noise
                .as_ref()
                .map(|values| pick(values, rows)),
        };
        // Columns are already validated and in seconds; do not normalize again.
        Self::assemble(self.source.clone(), peaks, layout)
    }

    pub fn source(&self) -> &SourceInfo {
        &self.source
    }

    pub fn summary(&self) -> &RunSummary {
        &self.summary
    }

    pub fn layout(&self) -> RunLayout {
        match self.layout {
            Layout::Flat { .. } => RunLayout::Flat,
            Layout::Scans(_) => RunLayout::Scans,
        }
    }

    pub fn schema(&self) -> RunSchema {
        RunSchema {
            layout: self.layout(),
            has_rt: self.selectable_rt().is_some(),
            has_signal_to_noise: self.peaks.signal_to_noise.is_some(),
        }
    }

    pub fn peak_count(&self) -> usize {
        self.peaks.mz.len()
    }

    /// `None` for flat runs.
    pub fn scan_count(&self) -> Option<usize> {
        self.scans().map(ScanTable::len)
    }

    /// True when there is nothing to select: no rows, or no scans.
    pub fn is_empty(&self) -> bool {
        self.scan_count().unwrap_or(self.peak_count()) == 0
    }

    pub fn mz(&self) -> &[f64] {
        &self.peaks.mz
    }

    pub fn intensity(&self) -> &[f64] {
        &self.peaks.intensity
    }

    pub fn signal_to_noise(&self) -> Option<&[Option<f64>]> {
        self.peaks.signal_to_noise.as_deref()
    }

    /// Per-peak RT in seconds for flat runs. Scan runs record RT on [`ScanTable::rt`].
    pub fn peak_rt(&self) -> Option<&[Option<f64>]> {
        self.peaks.rt.as_deref()
    }

    /// Source-local peak identities of a flat run.
    pub fn peak_ids(&self) -> Option<&[u64]> {
        match &self.layout {
            Layout::Flat { peak_id } => Some(peak_id),
            Layout::Scans(_) => None,
        }
    }

    pub fn scans(&self) -> Option<&ScanTable> {
        match &self.layout {
            Layout::Flat { .. } => None,
            Layout::Scans(scans) => Some(scans),
        }
    }

    pub fn spectrum(&self, scan: usize) -> Option<Spectrum<'_>> {
        let scans = self.scans()?;
        (scan < scans.len()).then_some(Spectrum {
            run: self,
            scans,
            scan,
        })
    }

    /// Borrowed views of each scan in order; flat runs have none.
    pub fn spectra(&self) -> impl ExactSizeIterator<Item = Spectrum<'_>> {
        let count = self.scan_count().unwrap_or(0);
        (0..count).map(|scan| self.spectrum(scan).expect("scan is in bounds"))
    }

    /// Returns one peak row; its RT is the peak RT or its scan's RT, in seconds.
    pub fn peak(&self, row: usize) -> Option<Peak> {
        let mz = *self.peaks.mz.get(row)?;
        let signal_to_noise = self
            .peaks
            .signal_to_noise
            .as_ref()
            .and_then(|values| values[row]);
        let rt = match &self.layout {
            Layout::Flat { .. } => self.peaks.rt.as_ref().and_then(|values| values[row]),
            Layout::Scans(scans) => {
                let scan = scans.peak_offsets().partition_point(|&start| start <= row) - 1;
                scans.rt()[scan]
            }
        };
        Some(Peak::from_validated(
            mz,
            self.peaks.intensity[row],
            signal_to_noise,
            rt,
        ))
    }

    /// Row views over every peak, in storage order, without another stored copy.
    pub fn peaks(&self) -> impl ExactSizeIterator<Item = Peak> + '_ {
        (0..self.peak_count()).map(|row| self.peak(row).expect("row is in bounds"))
    }
}

/// A borrowed view of one scan and its peaks.
#[derive(Clone, Copy, Debug)]
pub struct Spectrum<'a> {
    run: &'a Run,
    scans: &'a ScanTable,
    scan: usize,
}

impl<'a> Spectrum<'a> {
    /// Position within the current run, which changes under selection.
    pub fn position(&self) -> usize {
        self.scan
    }

    /// Source scan index, preserved by selection.
    pub fn index(&self) -> u64 {
        self.scans.index()[self.scan]
    }

    pub fn native_id(&self) -> &'a str {
        &self.scans.native_id()[self.scan]
    }

    pub fn ms_level(&self) -> u8 {
        self.scans.ms_level()[self.scan]
    }

    /// RT in seconds.
    pub fn rt(&self) -> Option<f64> {
        self.scans.rt()[self.scan]
    }

    pub fn polarity(&self) -> Option<Polarity> {
        self.scans.polarity()[self.scan]
    }

    pub fn representation(&self) -> Option<Representation> {
        self.scans.representation()[self.scan]
    }

    pub fn peak_range(&self) -> Range<usize> {
        self.scans.peak_range(self.scan)
    }

    pub fn mz(&self) -> &'a [f64] {
        &self.run.peaks.mz[self.peak_range()]
    }

    pub fn intensity(&self) -> &'a [f64] {
        &self.run.peaks.intensity[self.peak_range()]
    }

    pub fn signal_to_noise(&self) -> Option<&'a [Option<f64>]> {
        let range = self.peak_range();
        self.run
            .peaks
            .signal_to_noise
            .as_deref()
            .map(|values| &values[range])
    }

    pub fn peaks(&self) -> impl ExactSizeIterator<Item = Peak> + 'a {
        let run = self.run;
        self.peak_range()
            .map(move |row| run.peak(row).expect("row is in bounds"))
    }
}

fn validate_peaks(peaks: &PeakColumns, expected: usize) -> Result<(), RunError> {
    let lengths = [
        ("mz", Some(peaks.mz.len())),
        ("intensity", Some(peaks.intensity.len())),
        ("rt", peaks.rt.as_ref().map(Vec::len)),
        (
            "signal_to_noise",
            peaks.signal_to_noise.as_ref().map(Vec::len),
        ),
    ];
    for (column, length) in lengths {
        if let Some(actual) = length
            && actual != expected
        {
            return Err(RunError::ColumnLengthMismatch {
                column,
                expected,
                actual,
            });
        }
    }
    for row in 0..expected {
        let signal_to_noise = peaks
            .signal_to_noise
            .as_ref()
            .and_then(|values| values[row]);
        Peak::new(peaks.mz[row], peaks.intensity[row], signal_to_noise)
            .map_err(|source| RunError::InvalidPeak { row, source })?;
    }
    Ok(())
}

fn normalize_rt(values: &mut [Option<f64>], unit: RtUnit) -> Result<(), (usize, RtUnitError)> {
    for (position, value) in values.iter_mut().enumerate() {
        if let Some(input) = value {
            *input = unit.to_seconds(*input).map_err(|error| (position, error))?;
        }
    }
    Ok(())
}

fn pick<T: Clone>(values: &[T], positions: &[usize]) -> Vec<T> {
    positions
        .iter()
        .map(|&position| values[position].clone())
        .collect()
}

fn bounds(mut values: impl Iterator<Item = f64>) -> Option<(f64, f64)> {
    let first = values.next()?;
    Some(values.fold((first, first), |(min, max), value| {
        (min.min(value), max.max(value))
    }))
}

#[derive(Clone, Debug, PartialEq)]
pub enum RunError {
    RtUnavailable,
    MsLevelUnavailable,
    InvalidQueryRt(RtUnitError),
    InvalidRtRange {
        start: f64,
        end: f64,
    },
    InvalidPeakRange {
        column: &'static str,
        minimum: f64,
        maximum: f64,
    },
    ColumnLengthMismatch {
        column: &'static str,
        expected: usize,
        actual: usize,
    },
    RtUnitMetadataMismatch,
    PeakRtInScanRun,
    DuplicatePeakId {
        row: usize,
        peak_id: u64,
    },
    InvalidPeak {
        row: usize,
        source: SpectrumError,
    },
    InvalidRt {
        row: usize,
        source: RtUnitError,
    },
    InvalidPeakOffsets {
        scan: usize,
    },
    DuplicateScanIndex {
        scan: usize,
        index: u64,
    },
    DuplicateNativeId {
        scan: usize,
    },
    InvalidMsLevel {
        scan: usize,
    },
    InvalidScanRt {
        scan: usize,
        source: RtUnitError,
    },
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RtUnavailable => f.write_str("the run has no RT column"),
            Self::MsLevelUnavailable => f.write_str("flat runs have no MS levels"),
            Self::InvalidQueryRt(source) => write!(f, "invalid query RT: {source}"),
            Self::InvalidRtRange { start, end } => {
                write!(f, "RT range start {start} exceeds end {end}")
            }
            Self::InvalidPeakRange {
                column,
                minimum,
                maximum,
            } => write!(
                f,
                "{column} slice bounds must be finite, nonnegative and ordered; got [{minimum}, {maximum}]"
            ),
            Self::ColumnLengthMismatch {
                column,
                expected,
                actual,
            } => write!(f, "{column} column has {actual} rows; expected {expected}"),
            Self::RtUnitMetadataMismatch => {
                f.write_str("RT values and source RT unit metadata must both be present or absent")
            }
            Self::PeakRtInScanRun => f.write_str("scan runs record RT per scan, not per peak"),
            Self::DuplicatePeakId { row, peak_id } => {
                write!(f, "row {row}: duplicate source peak ID {peak_id}")
            }
            Self::InvalidPeak { row, source } => write!(f, "row {row}: invalid peak: {source}"),
            Self::InvalidRt { row, source } => write!(f, "row {row}: invalid RT: {source}"),
            Self::InvalidPeakOffsets { scan } => write!(
                f,
                "scan {scan}: peak offsets must start at zero, not decrease, and end at the peak count"
            ),
            Self::DuplicateScanIndex { scan, index } => {
                write!(f, "scan {scan}: duplicate source scan index {index}")
            }
            Self::DuplicateNativeId { scan } => write!(f, "scan {scan}: duplicate native ID"),
            Self::InvalidMsLevel { scan } => write!(f, "scan {scan}: MS level must be at least 1"),
            Self::InvalidScanRt { scan, source } => write!(f, "scan {scan}: invalid RT: {source}"),
        }
    }
}

impl std::error::Error for RunError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidQueryRt(source)
            | Self::InvalidRt { source, .. }
            | Self::InvalidScanRt { source, .. } => Some(source),
            Self::InvalidPeak { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(rt_unit: Option<RtUnitMetadata>) -> SourceInfo {
        SourceInfo {
            source_id: "import-1".to_owned(),
            filename: "peaks.csv".to_owned(),
            reader_format: "txt".to_owned(),
            rt_unit,
        }
    }

    fn ids() -> Vec<u64> {
        vec![8, 2, 5]
    }

    fn columns() -> PeakColumns {
        PeakColumns {
            mz: vec![100.0, 50.0, 100.0],
            intensity: vec![0.0, 20.0, 10.0],
            rt: None,
            signal_to_noise: None,
        }
    }

    fn minutes() -> Option<RtUnitMetadata> {
        Some(RtUnitMetadata::resolve(None, Some(RtUnit::Minutes)).unwrap())
    }

    fn seconds() -> Option<RtUnitMetadata> {
        Some(RtUnitMetadata::resolve(None, None).unwrap())
    }

    #[test]
    fn resolves_unit_provenance_and_rejects_conflicts() {
        let cases = [
            (None, None, RtUnit::Seconds, RtUnitOrigin::Default),
            (
                None,
                Some(RtUnit::Minutes),
                RtUnit::Minutes,
                RtUnitOrigin::Caller,
            ),
            (
                Some(RtUnit::Milliseconds),
                None,
                RtUnit::Milliseconds,
                RtUnitOrigin::Declared,
            ),
            (
                Some(RtUnit::Minutes),
                Some(RtUnit::Minutes),
                RtUnit::Minutes,
                RtUnitOrigin::Declared,
            ),
        ];
        for (declared, caller, unit, origin) in cases {
            let metadata = RtUnitMetadata::resolve(declared, caller).unwrap();
            assert_eq!(metadata.input_unit(), unit);
            assert_eq!(metadata.declared_unit(), declared);
            assert_eq!(metadata.origin(), origin);
        }
        assert_eq!(
            RtUnitMetadata::resolve(Some(RtUnit::Minutes), Some(RtUnit::Seconds)),
            Err(RtUnitError::ConflictingUnits {
                declared: RtUnit::Minutes,
                caller: RtUnit::Seconds,
            })
        );
    }

    #[test]
    fn converts_units_and_rejects_invalid_times_and_overflow() {
        for (name, input, seconds) in [
            ("seconds", 5.5, 5.5),
            ("minutes", 5.5, 330.0),
            ("milliseconds", 5500.0, 5.5),
        ] {
            let unit: RtUnit = name.parse().unwrap();
            assert_eq!(unit.to_seconds(input), Ok(seconds));
            assert_eq!(unit.to_seconds(0.0), Ok(0.0));
            for invalid in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                assert_eq!(
                    unit.to_seconds(invalid),
                    Err(RtUnitError::InvalidRetentionTime)
                );
            }
        }
        assert_eq!(
            RtUnit::Minutes.to_seconds(f64::MAX),
            Err(RtUnitError::ConversionOverflow)
        );
        assert!(matches!(
            "hours".parse::<RtUnit>(),
            Err(RtUnitError::UnsupportedUnit(_))
        ));
    }

    #[test]
    fn normalizes_rt_preserving_nulls_order_identities_and_measurements() {
        let mut columns = columns();
        columns.rt = Some(vec![Some(5.5), None, Some(0.0)]);
        columns.signal_to_noise = Some(vec![None, Some(0.0), Some(10.0)]);
        let run = Run::flat(source(minutes()), ids(), columns).unwrap();
        assert_eq!(run.layout(), RunLayout::Flat);
        assert_eq!(run.peak_ids(), Some([8, 2, 5].as_slice()));
        assert_eq!(run.mz(), &[100.0, 50.0, 100.0]);
        assert_eq!(run.intensity(), &[0.0, 20.0, 10.0]);
        assert_eq!(
            run.peak_rt(),
            Some([Some(330.0), None, Some(0.0)].as_slice())
        );
        assert_eq!(
            run.signal_to_noise(),
            Some([None, Some(0.0), Some(10.0)].as_slice())
        );
        assert_eq!(run.source().rt_unit, minutes());
        assert_eq!(run.scans(), None);
        assert_eq!(run.spectra().len(), 0);
        assert_eq!(
            run.summary(),
            &RunSummary {
                peak_count: 3,
                scan_count: None,
                mz_bounds: Some((50.0, 100.0)),
                intensity_bounds: Some((0.0, 20.0)),
                rt_bounds: Some((0.0, 330.0)),
            }
        );
        let rows: Vec<_> = run.peaks().collect();
        assert_eq!(rows[0].retention_time(), Some(330.0));
        assert_eq!(rows[1].retention_time(), None);
        assert_eq!(rows[1].signal_to_noise(), Some(0.0));
        assert_eq!(run.peak(3), None);
    }

    #[test]
    fn distinguishes_absent_all_null_and_empty_columns() {
        let absent = Run::flat(source(None), ids(), columns()).unwrap();
        assert!(!absent.schema().has_rt);
        let mut null_columns = columns();
        null_columns.rt = Some(vec![None; 3]);
        let all_null = Run::flat(source(seconds()), ids(), null_columns).unwrap();
        assert!(all_null.schema().has_rt);
        assert_eq!(all_null.summary().rt_bounds, None);
        let empty = Run::flat(
            source(seconds()),
            vec![],
            PeakColumns {
                rt: Some(vec![]),
                signal_to_noise: Some(vec![]),
                ..PeakColumns::default()
            },
        )
        .unwrap();
        assert!(empty.is_empty());
        assert!(empty.schema().has_rt);
        assert!(empty.schema().has_signal_to_noise);
        assert_eq!(empty.peak_rt(), Some([].as_slice()));
        assert_eq!(empty.summary().mz_bounds, None);
        assert_eq!(empty.summary().intensity_bounds, None);
        assert_eq!(empty.summary().rt_bounds, None);
    }

    #[test]
    fn rejects_misaligned_columns_duplicate_ids_and_missing_unit_metadata() {
        for name in ["mz", "intensity", "rt", "signal_to_noise"] {
            let mut columns = columns();
            match name {
                "mz" => {
                    columns.mz.pop();
                }
                "intensity" => {
                    columns.intensity.pop();
                }
                "rt" => columns.rt = Some(vec![None; 2]),
                "signal_to_noise" => columns.signal_to_noise = Some(vec![None; 2]),
                _ => unreachable!(),
            }
            assert_eq!(
                Run::flat(source(None), ids(), columns),
                Err(RunError::ColumnLengthMismatch {
                    column: name,
                    expected: 3,
                    actual: 2,
                })
            );
        }
        assert_eq!(
            Run::flat(source(None), vec![8, 2, 8], columns()),
            Err(RunError::DuplicatePeakId { row: 2, peak_id: 8 })
        );
        let mut with_rt = columns();
        with_rt.rt = Some(vec![None; 3]);
        assert_eq!(
            Run::flat(source(None), ids(), with_rt),
            Err(RunError::RtUnitMetadataMismatch)
        );
        assert_eq!(
            Run::flat(source(seconds()), ids(), columns()),
            Err(RunError::RtUnitMetadataMismatch)
        );
    }

    #[test]
    fn rejects_invalid_measurements_with_row_context() {
        for (mz, intensity, sn, expected) in [
            (0.0, 1.0, None, SpectrumError::InvalidMz),
            (f64::NAN, 1.0, None, SpectrumError::InvalidMz),
            (1.0, -1.0, None, SpectrumError::InvalidIntensity),
            (1.0, f64::INFINITY, None, SpectrumError::InvalidIntensity),
            (1.0, 1.0, Some(-1.0), SpectrumError::InvalidSignalToNoise),
            (
                1.0,
                1.0,
                Some(f64::NAN),
                SpectrumError::InvalidSignalToNoise,
            ),
        ] {
            let mut columns = columns();
            columns.mz[1] = mz;
            columns.intensity[1] = intensity;
            columns.signal_to_noise = Some(vec![None, sn, None]);
            assert_eq!(
                Run::flat(source(None), ids(), columns),
                Err(RunError::InvalidPeak {
                    row: 1,
                    source: expected
                })
            );
        }
        for (value, expected) in [
            (-1.0, RtUnitError::InvalidRetentionTime),
            (f64::INFINITY, RtUnitError::InvalidRetentionTime),
            (f64::MAX, RtUnitError::ConversionOverflow),
        ] {
            let mut columns = columns();
            columns.rt = Some(vec![None, Some(value), None]);
            let error = Run::flat(source(minutes()), ids(), columns).unwrap_err();
            assert_eq!(
                error,
                RunError::InvalidRt {
                    row: 1,
                    source: expected
                }
            );
            assert!(std::error::Error::source(&error).is_some());
        }
    }

    fn selection_run() -> Run {
        Run::flat(
            source(minutes()),
            vec![8, 2, 5, 9, 7],
            PeakColumns {
                mz: vec![100.0, 50.0, 100.0, 20.0, 75.0],
                intensity: vec![0.0, 20.0, 10.0, 30.0, 5.0],
                rt: Some(vec![Some(6.0), Some(5.0), Some(5.0), None, Some(0.0)]),
                signal_to_noise: Some(vec![None, Some(0.0), Some(10.0), None, None]),
            },
        )
        .unwrap()
    }

    #[test]
    fn equal_bound_slice_preserves_duplicates_values_schema_and_source() {
        let run = selection_run();
        let selected = run.get_rt_slice(300.0, 300.0).unwrap();
        assert_eq!(selected.peak_ids(), Some([2, 5].as_slice()));
        assert_eq!(selected.mz(), &[50.0, 100.0]);
        assert_eq!(selected.intensity(), &[20.0, 10.0]);
        assert_eq!(
            selected.peak_rt(),
            Some([Some(300.0), Some(300.0)].as_slice())
        );
        assert_eq!(
            selected.signal_to_noise(),
            Some([Some(0.0), Some(10.0)].as_slice())
        );
        assert_eq!(selected.schema(), run.schema());
        assert_eq!(selected.source(), run.source());
        assert_eq!(selected.summary().rt_bounds, Some((300.0, 300.0)));
        assert_eq!(run.peak_count(), 5);
        assert_eq!(run.summary().rt_bounds, Some((0.0, 360.0)));
        let adjacent = f64::from_bits(300.0_f64.to_bits() + 1);
        let empty = run.get_rt_slice(adjacent, adjacent).unwrap();
        assert!(empty.is_empty());
        assert_eq!(empty.schema(), run.schema());
        assert_eq!(empty.peak_rt(), Some([].as_slice()));
        assert_eq!(empty.summary().mz_bounds, None);
    }

    #[test]
    fn rt_slice_includes_both_bounds_and_preserves_source_order() {
        let run = selection_run();
        assert_eq!(
            run.get_rt_slice(300.0, 360.0).unwrap().peak_ids(),
            Some([8, 2, 5].as_slice())
        );
        assert_eq!(
            run.get_rt_slice(0.0, 300.0).unwrap().peak_ids(),
            Some([2, 5, 7].as_slice())
        );
        assert_eq!(
            run.get_rt_slice(0.0, f64::MAX).unwrap().peak_ids(),
            Some([8, 2, 5, 7].as_slice())
        );
    }

    #[test]
    fn range_and_chained_selections_use_seconds_and_only_retained_rows() {
        let run = selection_run();
        let region = run.get_rt_range(300.0, 360.0).unwrap();
        assert_eq!(region.peak_ids(), Some([2, 5].as_slice()));
        assert_eq!(region.get_rt_slice(300.0, 300.0).unwrap(), region);
        assert!(region.get_rt_slice(360.0, 360.0).unwrap().is_empty());
        assert!(run.get_rt_range(300.0, 300.0).unwrap().is_empty());
        assert_eq!(
            run.get_rt_range(0.0, 300.0).unwrap().peak_ids(),
            Some([7].as_slice())
        );
        let later = run.get_rt_range(360.0, 400.0).unwrap();
        assert_eq!(
            later.get_rt_slice(360.0, 360.0).unwrap().peak_ids(),
            Some([8].as_slice())
        );
        assert!(later.get_rt_slice(0.0, 300.0).unwrap().is_empty());
        assert_eq!(later.source(), run.source());
        assert_eq!(run.get_ms_level(1), Err(RunError::MsLevelUnavailable));
    }

    #[test]
    fn peak_slices_are_inclusive_and_preserve_rows_and_metadata() {
        let run = selection_run();
        let selected = run.get_mz_slice(50.0, 100.0).unwrap();
        assert_eq!(selected.peak_ids(), Some([8, 2, 5, 7].as_slice()));
        assert_eq!(selected.mz(), &[100.0, 50.0, 100.0, 75.0]);
        assert_eq!(
            selected.peak_rt(),
            Some([Some(360.0), Some(300.0), Some(300.0), Some(0.0)].as_slice())
        );
        assert_eq!(
            selected.signal_to_noise(),
            Some([None, Some(0.0), Some(10.0), None].as_slice())
        );
        assert_eq!(selected.source(), run.source());
        assert_eq!(selected.schema(), run.schema());
        assert_eq!(selected.summary().mz_bounds, Some((50.0, 100.0)));
        assert_eq!(
            run.get_mz_slice(100.0, 100.0).unwrap().peak_ids(),
            Some([8, 5].as_slice())
        );
        assert_eq!(
            run.get_intensity_slice(5.0, 20.0).unwrap().peak_ids(),
            Some([2, 5, 7].as_slice())
        );
        assert_eq!(
            selected.get_intensity_slice(0.0, 0.0).unwrap().peak_ids(),
            Some([8].as_slice())
        );
        assert_eq!(
            run.get_intensity_slice(30.0, 30.0).unwrap().peak_rt(),
            Some([None].as_slice())
        );
        let empty = run.get_mz_slice(200.0, 300.0).unwrap();
        assert!(empty.is_empty());
        assert_eq!(empty.schema(), run.schema());
        assert_eq!(empty.source(), run.source());
        assert_eq!(empty.peak_rt(), Some([].as_slice()));
        assert_eq!(empty.summary().mz_bounds, None);
        assert_eq!(run.peak_count(), 5);
    }

    #[test]
    fn peak_slices_reject_invalid_bounds() {
        let run = selection_run();
        for (minimum, maximum) in [
            (f64::NAN, 1.0),
            (0.0, f64::NAN),
            (f64::NEG_INFINITY, 1.0),
            (0.0, f64::INFINITY),
            (-1.0, 1.0),
            (2.0, 1.0),
        ] {
            assert!(matches!(
                run.get_mz_slice(minimum, maximum),
                Err(RunError::InvalidPeakRange { column: "m/z", .. })
            ));
            assert!(matches!(
                run.get_intensity_slice(minimum, maximum),
                Err(RunError::InvalidPeakRange {
                    column: "intensity",
                    ..
                })
            ));
        }
    }

    #[test]
    fn selection_distinguishes_unavailable_rt_from_no_matches_and_rejects_bad_queries() {
        let absent = Run::flat(source(None), ids(), columns()).unwrap();
        assert_eq!(absent.get_rt_slice(1.0, 1.0), Err(RunError::RtUnavailable));
        assert_eq!(absent.get_rt_range(0.0, 1.0), Err(RunError::RtUnavailable));
        let mut nulls = columns();
        nulls.rt = Some(vec![None; 3]);
        let all_null = Run::flat(source(seconds()), ids(), nulls).unwrap();
        let empty = all_null.get_rt_slice(1.0, 1.0).unwrap();
        assert!(empty.is_empty());
        assert!(empty.get_rt_slice(1.0, 1.0).unwrap().is_empty());
        assert_eq!(empty.source(), all_null.source());
        assert_eq!(empty.schema(), all_null.schema());
        assert!(all_null.get_rt_range(0.0, 2.0).unwrap().is_empty());
        for invalid in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for (start, end) in [(invalid, 1.0), (0.0, invalid)] {
                assert!(matches!(
                    all_null.get_rt_slice(start, end),
                    Err(RunError::InvalidQueryRt(_))
                ));
                assert!(matches!(
                    all_null.get_rt_range(start, end),
                    Err(RunError::InvalidQueryRt(_))
                ));
            }
        }
        assert_eq!(
            all_null.get_rt_range(2.0, 1.0),
            Err(RunError::InvalidRtRange {
                start: 2.0,
                end: 1.0
            })
        );
        assert_eq!(
            all_null.get_rt_slice(2.0, 1.0),
            Err(RunError::InvalidRtRange {
                start: 2.0,
                end: 1.0
            })
        );
    }

    fn scan_columns() -> ScanColumns {
        ScanColumns {
            index: vec![10, 11, 12, 13],
            native_id: ["scan=1", "scan=2", "scan=3", "scan=4"]
                .map(String::from)
                .to_vec(),
            ms_level: vec![1, 2, 1, 2],
            rt: vec![Some(1.0), Some(1.0), Some(2.0), None],
            polarity: vec![Some(Polarity::Positive), None, None, None],
            representation: vec![Some(Representation::Centroid), None, None, None],
            peak_offsets: vec![0, 2, 3, 3, 5],
        }
    }

    fn scan_peaks() -> PeakColumns {
        PeakColumns {
            mz: vec![100.0, 200.0, 150.0, 300.0, 400.0],
            intensity: vec![1.0, 2.0, 3.0, 4.0, 5.0],
            rt: None,
            signal_to_noise: Some(vec![Some(1.0), None, Some(3.0), None, None]),
        }
    }

    fn scan_run() -> Run {
        Run::with_scans(source(minutes()), scan_columns(), scan_peaks()).unwrap()
    }

    #[test]
    fn scan_runs_expose_scan_metadata_spectrum_views_and_scan_rt_rows() {
        let run = scan_run();
        assert_eq!(run.layout(), RunLayout::Scans);
        assert!(run.schema().has_rt);
        assert_eq!(run.peak_rt(), None);
        assert_eq!(run.peak_ids(), None);
        assert_eq!(run.scan_count(), Some(4));
        let scans = run.scans().unwrap();
        assert_eq!(scans.rt(), &[Some(60.0), Some(60.0), Some(120.0), None]);
        assert_eq!(scans.peak_range(2), 3..3);
        assert_eq!(run.summary().rt_bounds, Some((60.0, 120.0)));
        assert_eq!(run.summary().scan_count, Some(4));
        let spectra: Vec<_> = run.spectra().collect();
        assert_eq!(spectra[0].native_id(), "scan=1");
        assert_eq!(spectra[0].index(), 10);
        assert_eq!(spectra[0].polarity(), Some(Polarity::Positive));
        assert_eq!(spectra[0].representation(), Some(Representation::Centroid));
        assert_eq!(spectra[0].mz(), &[100.0, 200.0]);
        assert_eq!(
            spectra[0].signal_to_noise(),
            Some([Some(1.0), None].as_slice())
        );
        assert!(spectra[2].mz().is_empty());
        assert_eq!(spectra[3].ms_level(), 2);
        assert_eq!(spectra[3].intensity(), &[4.0, 5.0]);
        let rt: Vec<_> = run.peaks().map(|peak| peak.retention_time()).collect();
        assert_eq!(rt, [Some(60.0), Some(60.0), Some(60.0), None, None]);
        assert_eq!(spectra[1].peaks().next().unwrap().mz(), 150.0);
        assert!(run.spectrum(4).is_none());
    }

    #[test]
    fn scan_selections_keep_whole_scans_and_rebuild_offsets() {
        let run = scan_run();
        let exact = run.get_rt_slice(60.0, 60.0).unwrap();
        assert_eq!(exact.scans().unwrap().index(), &[10, 11]);
        assert_eq!(exact.scans().unwrap().peak_offsets(), &[0, 2, 3]);
        assert_eq!(exact.mz(), &[100.0, 200.0, 150.0]);
        assert_eq!(
            exact.signal_to_noise(),
            Some([Some(1.0), None, Some(3.0)].as_slice())
        );
        assert_eq!(exact.source(), run.source());
        assert_eq!(run.get_rt_range(60.0, 120.0).unwrap(), exact);
        let inclusive = run.get_rt_slice(60.0, 120.0).unwrap();
        assert_eq!(inclusive.scans().unwrap().index(), &[10, 11, 12]);
        assert_eq!(inclusive.scans().unwrap().peak_offsets(), &[0, 2, 3, 3]);
        assert_eq!(inclusive.mz(), &[100.0, 200.0, 150.0]);

        let ms1 = run.get_ms_level(1).unwrap();
        assert_eq!(ms1.scans().unwrap().native_id(), &["scan=1", "scan=3"]);
        let both = ms1.get_rt_slice(60.0, 120.0).unwrap();
        assert_eq!(both.scans().unwrap().index(), &[10, 12]);
        let empty_scan = ms1.get_rt_slice(120.0, 120.0).unwrap();
        assert_eq!(empty_scan.scan_count(), Some(1));
        assert_eq!(empty_scan.peak_count(), 0);
        assert!(!empty_scan.is_empty());

        let none = run.get_rt_slice(1.0, 1.0).unwrap();
        assert!(none.is_empty());
        assert_eq!(none.scans().unwrap().peak_offsets(), &[0]);
        assert_eq!(none.schema(), run.schema());
    }

    #[test]
    fn peak_slices_preserve_all_scans_and_rebuild_offsets() {
        let run = scan_run();
        for selected in [
            run.get_mz_slice(150.0, 300.0).unwrap(),
            run.get_intensity_slice(2.0, 4.0).unwrap(),
        ] {
            let mut expected_scans = run.scans().unwrap().0.clone();
            expected_scans.peak_offsets = vec![0, 1, 2, 2, 3];
            assert_eq!(selected.scans(), Some(&ScanTable(expected_scans)));
            assert_eq!(selected.mz(), &[200.0, 150.0, 300.0]);
            assert_eq!(selected.intensity(), &[2.0, 3.0, 4.0]);
            assert_eq!(
                selected.signal_to_noise(),
                Some([None, Some(3.0), None].as_slice())
            );
            assert_eq!(selected.peak(1).unwrap().retention_time(), Some(60.0));
            assert_eq!(selected.peak(2).unwrap().retention_time(), None);
            assert_eq!(selected.source(), run.source());
            assert_eq!(selected.schema(), run.schema());
            assert_eq!(selected.summary().mz_bounds, Some((150.0, 300.0)));
            assert_eq!(selected.summary().scan_count, Some(4));
            let ms1 = selected.get_ms_level(1).unwrap();
            assert_eq!(ms1.scans().unwrap().peak_offsets(), &[0, 1, 1]);
            assert_eq!(ms1.mz(), &[200.0]);
        }
        let empty = run.get_mz_slice(500.0, 600.0).unwrap();
        assert_eq!(empty.peak_count(), 0);
        assert_eq!(empty.scans().unwrap().peak_offsets(), &[0, 0, 0, 0, 0]);
        assert_eq!(empty.summary().rt_bounds, run.summary().rt_bounds);
        assert!(!empty.is_empty());
        assert_eq!(run.peak_count(), 5);
    }

    #[test]
    fn rejects_inconsistent_scan_structure() {
        let build = |scans: ScanColumns, peaks: PeakColumns, unit| {
            Run::with_scans(source(unit), scans, peaks)
        };
        let mut offsets = scan_columns();
        offsets.peak_offsets = vec![0, 2, 1, 3, 5];
        assert_eq!(
            build(offsets, scan_peaks(), minutes()),
            Err(RunError::InvalidPeakOffsets { scan: 1 })
        );
        let mut offsets = scan_columns();
        offsets.peak_offsets = vec![1, 2, 3, 3, 5];
        assert_eq!(
            build(offsets, scan_peaks(), minutes()),
            Err(RunError::InvalidPeakOffsets { scan: 0 })
        );
        let mut offsets = scan_columns();
        offsets.peak_offsets = vec![0, 2, 3, 3, 4];
        assert_eq!(
            build(offsets, scan_peaks(), minutes()),
            Err(RunError::InvalidPeakOffsets { scan: 3 })
        );
        let mut offsets = scan_columns();
        offsets.peak_offsets.pop();
        assert_eq!(
            build(offsets, scan_peaks(), minutes()),
            Err(RunError::ColumnLengthMismatch {
                column: "peak_offsets",
                expected: 5,
                actual: 4
            })
        );
        let mut duplicate = scan_columns();
        duplicate.index[3] = 10;
        assert_eq!(
            build(duplicate, scan_peaks(), minutes()),
            Err(RunError::DuplicateScanIndex { scan: 3, index: 10 })
        );
        let mut duplicate = scan_columns();
        duplicate.native_id[1] = "scan=1".into();
        assert_eq!(
            build(duplicate, scan_peaks(), minutes()),
            Err(RunError::DuplicateNativeId { scan: 1 })
        );
        let mut level = scan_columns();
        level.ms_level[2] = 0;
        assert_eq!(
            build(level, scan_peaks(), minutes()),
            Err(RunError::InvalidMsLevel { scan: 2 })
        );
        let mut rt = scan_columns();
        rt.rt[1] = Some(-1.0);
        assert!(matches!(
            build(rt, scan_peaks(), minutes()),
            Err(RunError::InvalidScanRt { scan: 1, .. })
        ));
        let mut peak_rt = scan_peaks();
        peak_rt.rt = Some(vec![None; 5]);
        assert_eq!(
            build(scan_columns(), peak_rt, minutes()),
            Err(RunError::PeakRtInScanRun)
        );
        assert_eq!(
            build(scan_columns(), scan_peaks(), None),
            Err(RunError::RtUnitMetadataMismatch)
        );
        let empty = build(
            ScanColumns {
                peak_offsets: vec![0],
                ..ScanColumns::default()
            },
            PeakColumns::default(),
            seconds(),
        )
        .unwrap();
        assert!(empty.is_empty());
        assert_eq!(empty.summary().rt_bounds, None);
    }
}

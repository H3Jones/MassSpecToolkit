use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;

use ms_core::run::{RtMode, RtUnit, RtUnitOrigin, Run, RunError, RunLayout};
use ms_core::spectrum::Peak;
use ms_readers::readers::txt::{
    TxtDelimiter, TxtFormat, TxtReadError, TxtReadOptions, guess_txt_format as guess_format, read,
};
use pyo3::exceptions::{PyIndexError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyType;

fn run_error(error: RunError) -> PyErr {
    PyValueError::new_err(error.to_string())
}

fn txt_error(error: TxtReadError) -> PyErr {
    match error {
        TxtReadError::Io(error) => error.into(),
        error => PyValueError::new_err(error.to_string()),
    }
}

fn layout_name(layout: RunLayout) -> &'static str {
    match layout {
        RunLayout::Flat => "flat",
        RunLayout::Scans => "scans",
    }
}

fn optional_repr<T: std::fmt::Debug>(value: Option<T>) -> String {
    value.map_or_else(|| "None".to_owned(), |value| format!("{value:?}"))
}

/// One peak row. RT is in seconds; `None` means the value is absent.
#[derive(Clone)]
#[pyclass(name = "Peak", frozen, get_all, module = "ms_py._core")]
struct PyPeak {
    mz: f64,
    intensity: f64,
    signal_to_noise: Option<f64>,
    retention_time: Option<f64>,
}

impl From<Peak> for PyPeak {
    fn from(peak: Peak) -> Self {
        Self {
            mz: peak.mz(),
            intensity: peak.intensity(),
            signal_to_noise: peak.signal_to_noise(),
            retention_time: peak.retention_time(),
        }
    }
}

#[pymethods]
impl PyPeak {
    fn __repr__(&self) -> String {
        format!(
            "Peak(mz={:?}, intensity={:?}, signal_to_noise={}, retention_time={})",
            self.mz,
            self.intensity,
            optional_repr(self.signal_to_noise),
            optional_repr(self.retention_time)
        )
    }
}

/// Optional-column presence; it survives empty runs and selections.
#[pyclass(name = "RunSchema", frozen, get_all, module = "ms_py._core")]
struct PyRunSchema {
    layout: &'static str,
    has_rt: bool,
    has_signal_to_noise: bool,
}

/// Source identity, preserved by selections.
#[pyclass(name = "SourceInfo", frozen, get_all, module = "ms_py._core")]
struct PySourceInfo {
    source_id: String,
    filename: String,
    reader_format: String,
    rt_unit: Option<String>,
    rt_unit_origin: Option<&'static str>,
    declared_rt_unit: Option<String>,
}

/// Counts and bounds for the current run only.
#[pyclass(name = "RunSummary", frozen, get_all, module = "ms_py._core")]
struct PyRunSummary {
    peak_count: usize,
    scan_count: Option<usize>,
    mz_bounds: Option<(f64, f64)>,
    intensity_bounds: Option<(f64, f64)>,
    rt_bounds: Option<(f64, f64)>,
}

/// A run of peaks. Selections return new runs; RT values and queries are seconds.
#[pyclass(name = "Run", frozen, module = "ms_py._core")]
struct PyRun(Run);

#[pymethods]
impl PyRun {
    /// Reads a text peak-list file into an eager flat run.
    ///
    /// `path` is a filesystem path, not text content. The layout is guessed
    /// unless `format` is supplied. `rt_unit` describes input RTs; returned
    /// RTs and queries are in seconds. `source_id` defaults to the filename.
    #[classmethod]
    #[pyo3(signature = (path, format=None, *, rt_unit=None, source_id=None))]
    fn from_text_file(
        _cls: &Bound<'_, PyType>,
        py: Python<'_>,
        path: PathBuf,
        format: Option<&PyTxtFormat>,
        rt_unit: Option<&str>,
        source_id: Option<String>,
    ) -> PyResult<Self> {
        read_txt(py, path, format, rt_unit, source_id)
    }

    #[getter]
    fn layout(&self) -> &'static str {
        layout_name(self.0.layout())
    }

    #[getter]
    fn schema(&self) -> PyRunSchema {
        let schema = self.0.schema();
        PyRunSchema {
            layout: layout_name(schema.layout),
            has_rt: schema.has_rt,
            has_signal_to_noise: schema.has_signal_to_noise,
        }
    }

    #[getter]
    fn source(&self) -> PySourceInfo {
        let source = self.0.source();
        let unit = source.rt_unit.as_ref();
        PySourceInfo {
            source_id: source.source_id.clone(),
            filename: source.filename.clone(),
            reader_format: source.reader_format.clone(),
            rt_unit: unit.map(|unit| unit.input_unit().to_string()),
            rt_unit_origin: unit.map(|unit| match unit.origin() {
                RtUnitOrigin::Declared => "declared",
                RtUnitOrigin::Caller => "caller",
                RtUnitOrigin::Default => "default",
            }),
            declared_rt_unit: unit
                .and_then(|unit| unit.declared_unit())
                .map(|unit| unit.to_string()),
        }
    }

    #[getter]
    fn summary(&self) -> PyRunSummary {
        let summary = self.0.summary();
        PyRunSummary {
            peak_count: summary.peak_count,
            scan_count: summary.scan_count,
            mz_bounds: summary.mz_bounds,
            intensity_bounds: summary.intensity_bounds,
            rt_bounds: summary.rt_bounds,
        }
    }

    #[getter]
    fn peak_count(&self) -> usize {
        self.0.peak_count()
    }

    #[getter]
    fn scan_count(&self) -> Option<usize> {
        self.0.scan_count()
    }

    #[getter]
    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    #[getter]
    fn mz(&self) -> Vec<f64> {
        self.0.mz().to_vec()
    }

    #[getter]
    fn intensity(&self) -> Vec<f64> {
        self.0.intensity().to_vec()
    }

    #[getter]
    fn signal_to_noise(&self) -> Option<Vec<Option<f64>>> {
        self.0.signal_to_noise().map(<[_]>::to_vec)
    }

    #[getter]
    fn peak_rt(&self) -> Option<Vec<Option<f64>>> {
        self.0.peak_rt().map(<[_]>::to_vec)
    }

    #[getter]
    fn peak_ids(&self) -> Option<Vec<u64>> {
        self.0.peak_ids().map(<[_]>::to_vec)
    }

    fn peak(&self, row: usize) -> PyResult<PyPeak> {
        self.0
            .peak(row)
            .map(PyPeak::from)
            .ok_or_else(|| PyIndexError::new_err("peak row out of range"))
    }

    fn peaks(&self) -> Vec<PyPeak> {
        self.0.peaks().map(PyPeak::from).collect()
    }

    /// Selects every unit at `rt` seconds (`mode="exact"`) or at the nearest RT.
    #[pyo3(signature = (rt, *, mode))]
    fn get_rt_slice(&self, rt: f64, mode: &str) -> PyResult<Self> {
        let mode = match mode {
            "exact" => RtMode::Exact,
            "nearest" => RtMode::Nearest,
            _ => {
                return Err(PyValueError::new_err(format!(
                    "mode must be \"exact\" or \"nearest\", got {mode:?}"
                )));
            }
        };
        self.0.get_rt_slice(rt, mode).map(Self).map_err(run_error)
    }

    /// Selects units with `start <= RT < end`, in seconds.
    fn get_rt_range(&self, start: f64, end: f64) -> PyResult<Self> {
        self.0.get_rt_range(start, end).map(Self).map_err(run_error)
    }

    fn get_ms_level(&self, level: u8) -> PyResult<Self> {
        self.0.get_ms_level(level).map(Self).map_err(run_error)
    }

    /// Returns an unrendered `seaborn.objects.Plot` of a single spectrum.
    #[pyo3(signature = (*, style = "sticks"))]
    fn plot_spectrum<'py>(slf: &Bound<'py, Self>, style: &str) -> PyResult<Bound<'py, PyAny>> {
        slf.py()
            .import("ms_py.plotting")?
            .call_method1("spectrum", (slf, style))
    }

    /// Returns an unrendered `seaborn.objects.Plot` of peak RT against m/z.
    fn plot_rt_mz<'py>(slf: &Bound<'py, Self>) -> PyResult<Bound<'py, PyAny>> {
        slf.py()
            .import("ms_py.plotting")?
            .call_method1("rt_mz", (slf,))
    }

    fn __repr__(&self) -> String {
        format!(
            "Run(layout='{}', peak_count={}, source_id='{}')",
            self.layout(),
            self.0.peak_count(),
            self.0.source().source_id
        )
    }
}

/// Text peak-list layout. Column indices are zero-based.
#[pyclass(name = "TxtFormat", frozen, module = "ms_py._core")]
struct PyTxtFormat(TxtFormat);

#[pymethods]
impl PyTxtFormat {
    #[new]
    #[pyo3(signature = (
        *,
        column_count,
        mz_column,
        intensity_column,
        delimiter=",",
        skip_lines=0,
        signal_to_noise_column=None,
        retention_time_column=None,
    ))]
    fn new(
        column_count: usize,
        mz_column: usize,
        intensity_column: usize,
        delimiter: &str,
        skip_lines: usize,
        signal_to_noise_column: Option<usize>,
        retention_time_column: Option<usize>,
    ) -> PyResult<Self> {
        let delimiter = if delimiter == "whitespace" {
            TxtDelimiter::Whitespace
        } else {
            let mut chars = delimiter.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => TxtDelimiter::Character(c),
                _ => {
                    return Err(PyValueError::new_err(
                        "delimiter must be one character or \"whitespace\"",
                    ));
                }
            }
        };
        let format = TxtFormat {
            delimiter,
            skip_lines,
            column_count,
            mz_column,
            intensity_column,
            signal_to_noise_column,
            retention_time_column,
        };
        format.validate().map_err(txt_error)?;
        Ok(Self(format))
    }

    #[getter]
    fn delimiter(&self) -> String {
        match self.0.delimiter {
            TxtDelimiter::Whitespace => "whitespace".to_owned(),
            TxtDelimiter::Character(c) => c.to_string(),
        }
    }

    #[getter]
    fn skip_lines(&self) -> usize {
        self.0.skip_lines
    }

    #[getter]
    fn column_count(&self) -> usize {
        self.0.column_count
    }

    #[getter]
    fn mz_column(&self) -> usize {
        self.0.mz_column
    }

    #[getter]
    fn intensity_column(&self) -> usize {
        self.0.intensity_column
    }

    #[getter]
    fn signal_to_noise_column(&self) -> Option<usize> {
        self.0.signal_to_noise_column
    }

    #[getter]
    fn retention_time_column(&self) -> Option<usize> {
        self.0.retention_time_column
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.0 == other.0
    }

    fn __repr__(&self) -> String {
        format!(
            "TxtFormat(delimiter='{}', skip_lines={}, column_count={}, mz_column={}, \
             intensity_column={}, signal_to_noise_column={}, retention_time_column={})",
            self.delimiter().escape_default(),
            self.0.skip_lines,
            self.0.column_count,
            self.0.mz_column,
            self.0.intensity_column,
            optional_repr(self.0.signal_to_noise_column),
            optional_repr(self.0.retention_time_column)
        )
    }
}

/// Guesses a text layout from the first 32 lines of a file.
#[pyfunction]
fn guess_txt_format(py: Python<'_>, path: PathBuf) -> PyResult<PyTxtFormat> {
    py.detach(|| {
        let file = File::open(&path).map_err(TxtReadError::Io)?;
        guess_format(BufReader::new(file))
    })
    .map(PyTxtFormat)
    .map_err(txt_error)
}

/// Reads a text peak list into a flat `Run`, guessing the layout if `format` is None.
#[pyfunction(signature = (path, format=None, *, rt_unit=None, source_id=None))]
fn read_txt(
    py: Python<'_>,
    path: PathBuf,
    format: Option<&PyTxtFormat>,
    rt_unit: Option<&str>,
    source_id: Option<String>,
) -> PyResult<PyRun> {
    let rt_unit = rt_unit
        .map(str::parse::<RtUnit>)
        .transpose()
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    let filename = path
        .file_name()
        .map_or_else(|| path.to_string_lossy(), |name| name.to_string_lossy())
        .into_owned();
    let options = TxtReadOptions {
        source_id: source_id.unwrap_or_else(|| filename.clone()),
        filename,
        rt_unit,
    };
    let format = format.map(|format| format.0.clone());
    py.detach(|| {
        let format = match format {
            Some(format) => format,
            None => {
                let file = File::open(&path).map_err(TxtReadError::Io)?;
                guess_format(BufReader::new(file))?
            }
        };
        let file = File::open(&path).map_err(TxtReadError::Io)?;
        read(file, &format, &options)
    })
    .map(PyRun)
    .map_err(txt_error)
}

pub fn register(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PyPeak>()?;
    module.add_class::<PyRunSchema>()?;
    module.add_class::<PySourceInfo>()?;
    module.add_class::<PyRunSummary>()?;
    module.add_class::<PyRun>()?;
    module.add_class::<PyTxtFormat>()?;
    module.add_function(wrap_pyfunction!(guess_txt_format, module)?)?;
    module.add_function(wrap_pyfunction!(read_txt, module)?)?;
    Ok(())
}

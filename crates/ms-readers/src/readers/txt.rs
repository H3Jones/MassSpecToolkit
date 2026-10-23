//! Configurable readers for unquoted, delimited text peak lists.
//!
//! Format guessing examines at most 32 physical lines. It recognizes whitespace,
//! tabs, commas, semicolons, and pipes, with an optional header. Headerless input
//! uses the first two columns for m/z and intensity; extra columns are ignored,
//! never assumed to be S/N or retention time. Recognized headers can map reordered
//! columns, S/N, and retention time (RT), retaining the original time units.
//! Blank lines and lines starting with `#` (after whitespace) are always ignored.
//! Arbitrary preambles require an explicit `skip_lines` value.
//!
//! Guessing consumes its input. Reopen or rewind it before reading the full file,
//! or pass a separate preview. No seeking is required by either function.
//!
//! ```
//! use ms_readers::readers::txt::{guess_txt_format, read};
//!
//! let input = "m/z,intensity,width\n202.85354,917992,0.00018\n";
//! let spec = guess_txt_format(input.as_bytes())?;
//! let spectrum = read(input.as_bytes(), &spec)?;
//! assert_eq!(spectrum.peaks()[0].signal_to_noise(), None);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

use std::{
    error::Error,
    fmt,
    io::{self, BufRead, BufReader, Read},
    num::ParseFloatError,
};

use ms_core::spectrum::{MassSpectrum, Peak, SpectrumError};

const PREVIEW_LINES: usize = 32;

/// How columns are separated. Character delimiters preserve empty fields;
/// whitespace combines consecutive whitespace characters into one separator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxtDelimiter {
    Whitespace,
    Character(char),
}

/// A complete text layout, usable without calling [`guess_txt_format`].
///
/// Column indices are zero-based. `skip_lines` counts physical lines, including
/// blanks and comments, before parsing begins. Every remaining nonblank,
/// noncomment line must have exactly `column_count` fields. Unmapped fields are
/// ignored and need not be numeric. Values use dot decimals and may use scientific
/// notation; quoted fields and decimal commas are not supported.
///
/// ```
/// use ms_readers::readers::txt::{TxtDelimiter, TxtFormat, read};
///
/// let spec = TxtFormat {
///     delimiter: TxtDelimiter::Character('\t'),
///     skip_lines: 1,
///     column_count: 3,
///     mz_column: 0,
///     intensity_column: 1,
///     signal_to_noise_column: None,
///     retention_time_column: None,
/// };
/// let spectrum = read("export\n202.85354\t917992\t0.00018\n".as_bytes(), &spec)?;
/// assert_eq!(spectrum.peaks()[0].signal_to_noise(), None);
/// # Ok::<(), Box<dyn std::error::Error>>(())
/// ```
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxtFormat {
    pub delimiter: TxtDelimiter,
    pub skip_lines: usize,
    pub column_count: usize,
    pub mz_column: usize,
    pub intensity_column: usize,
    pub signal_to_noise_column: Option<usize>,
    pub retention_time_column: Option<usize>,
}

impl TxtFormat {
    fn validate(&self) -> Result<(), TxtReadError> {
        if matches!(self.delimiter, TxtDelimiter::Character('\r' | '\n' | '\0')) {
            return Err(TxtReadError::InvalidSpec(
                "delimiter cannot be a line ending or NUL",
            ));
        }
        let columns = [
            Some(self.mz_column),
            Some(self.intensity_column),
            self.signal_to_noise_column,
            self.retention_time_column,
        ];
        if columns.iter().flatten().any(|&i| i >= self.column_count) {
            return Err(TxtReadError::InvalidSpec(
                "mapped columns must be within column_count",
            ));
        }
        let mapped: Vec<_> = columns.into_iter().flatten().collect();
        if mapped
            .iter()
            .enumerate()
            .any(|(index, column)| mapped[..index].contains(column))
        {
            return Err(TxtReadError::InvalidSpec(
                "m/z, intensity, S/N, and retention time must use distinct columns",
            ));
        }
        Ok(())
    }
}

/// Reads the entire input using an explicit (or previously guessed) layout.
///
/// Peak order, duplicate m/z values, and original intensities are preserved.
/// Missing or malformed data is an error, not silently skipped. Empty input
/// produces an empty spectrum, but an invalid spec is rejected even for empty input.
pub fn read<R: Read>(input: R, spec: &TxtFormat) -> Result<MassSpectrum, TxtReadError> {
    spec.validate()?;
    let mut peaks = Vec::new();
    for (index, line) in BufReader::new(input).lines().enumerate() {
        let line = line.map_err(TxtReadError::Io)?;
        let line = strip_bom(&line, index);
        if index < spec.skip_lines || is_ignored(line) {
            continue;
        }
        peaks.push(parse_peak(line, index + 1, spec)?);
    }
    Ok(MassSpectrum::new(peaks))
}

/// Guesses a layout from at most the first 32 physical lines.
///
/// The preview must contain at least one data row. All sampled data rows are
/// validated against the inferred layout. Unsupported/ambiguous headers,
/// malformed rows, and I/O failures are reported rather than guessed around.
/// Full-file validation still happens in [`read`].
pub fn guess_txt_format<R: BufRead>(input: R) -> Result<TxtFormat, TxtReadError> {
    let mut spec = None;
    let mut has_data = false;
    for (index, line) in input.lines().take(PREVIEW_LINES).enumerate() {
        let line = line.map_err(TxtReadError::Io)?;
        let line = strip_bom(&line, index);
        if is_ignored(line) {
            continue;
        }
        if let Some(spec) = &spec {
            parse_peak(line, index + 1, spec)?;
            has_data = true;
        } else {
            let (guessed, is_header) = guess_line(line, index + 1)?;
            if !is_header {
                parse_peak(line, index + 1, &guessed)?;
                has_data = true;
            }
            spec = Some(guessed);
        }
    }
    if !has_data {
        return Err(TxtReadError::NoSampleData);
    }
    spec.ok_or(TxtReadError::NoSampleData)
}

fn strip_bom(line: &str, index: usize) -> &str {
    if index == 0 {
        line.strip_prefix('\u{feff}').unwrap_or(line)
    } else {
        line
    }
}

fn is_ignored(line: &str) -> bool {
    line.trim().is_empty() || line.trim_start().starts_with('#')
}

fn split_columns(line: &str, delimiter: TxtDelimiter) -> Vec<&str> {
    match delimiter {
        TxtDelimiter::Whitespace => line.split_whitespace().collect(),
        TxtDelimiter::Character(separator) => line.split(separator).map(str::trim).collect(),
    }
}

fn parse_peak(line: &str, line_number: usize, spec: &TxtFormat) -> Result<Peak, TxtReadError> {
    let columns = split_columns(line, spec.delimiter);
    if columns.len() != spec.column_count {
        return Err(TxtReadError::InvalidColumnCount {
            line: line_number,
            expected: spec.column_count,
            actual: columns.len(),
        });
    }
    let parse_column = |column: usize| {
        columns[column]
            .parse::<f64>()
            .map_err(|source| TxtReadError::InvalidNumber {
                line: line_number,
                column: column + 1,
                value: columns[column].to_owned(),
                source,
            })
    };
    let peak = Peak::new(
        parse_column(spec.mz_column)?,
        parse_column(spec.intensity_column)?,
        spec.signal_to_noise_column.map(parse_column).transpose()?,
    )
    .map_err(|source| TxtReadError::InvalidPeak {
        line: line_number,
        source,
    })?;
    match spec.retention_time_column {
        Some(column) => peak
            .with_retention_time(parse_column(column)?)
            .map_err(|source| TxtReadError::InvalidPeak {
                line: line_number,
                source,
            }),
        None => Ok(peak),
    }
}

const MZ_HEADERS: &[&str] = &["mz", "m/z"];
const INTENSITY_HEADERS: &[&str] = &["intensity", "i", "abundance"];
const SIGNAL_TO_NOISE_HEADERS: &[&str] = &["sn", "snr"];
const RETENTION_TIME_HEADERS: &[&str] = &["rt", "retentiontime"];

fn guess_line(line: &str, line_number: usize) -> Result<(TxtFormat, bool), TxtReadError> {
    let delimiters = [
        TxtDelimiter::Character('\t'),
        TxtDelimiter::Character(','),
        TxtDelimiter::Character(';'),
        TxtDelimiter::Character('|'),
        TxtDelimiter::Whitespace,
    ];
    for delimiter in delimiters {
        let columns = split_columns(line, delimiter);
        if columns.len() < 2 {
            continue;
        }
        let mut mz = Vec::new();
        let mut intensity = Vec::new();
        let mut sn = Vec::new();
        let mut rt = Vec::new();
        for (index, column) in columns.iter().enumerate() {
            let name: String = column
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .map(|c| c.to_ascii_lowercase())
                .collect();
            match name.as_str() {
                name if MZ_HEADERS.contains(&name) => mz.push(index),
                name if INTENSITY_HEADERS.contains(&name) => intensity.push(index),
                name if SIGNAL_TO_NOISE_HEADERS.contains(&name) => {
                    sn.push(index);
                }
                name if RETENTION_TIME_HEADERS.contains(&name) => rt.push(index),
                _ => {}
            }
        }
        if !mz.is_empty() && !intensity.is_empty() {
            if mz.len() != 1 || intensity.len() != 1 || sn.len() > 1 || rt.len() > 1 {
                return Err(TxtReadError::UnrecognizedFormat { line: line_number });
            }
            return Ok((
                TxtFormat {
                    delimiter,
                    skip_lines: line_number,
                    column_count: columns.len(),
                    mz_column: mz[0],
                    intensity_column: intensity[0],
                    signal_to_noise_column: sn.first().copied(),
                    retention_time_column: rt.first().copied(),
                },
                true,
            ));
        }
    }
    for delimiter in delimiters {
        let columns = split_columns(line, delimiter);
        if columns.len() >= 2
            && columns[0].parse::<f64>().is_ok()
            && columns[1].parse::<f64>().is_ok()
        {
            return Ok((
                TxtFormat {
                    delimiter,
                    skip_lines: line_number - 1,
                    column_count: columns.len(),
                    mz_column: 0,
                    intensity_column: 1,
                    signal_to_noise_column: None,
                    retention_time_column: None,
                },
                false,
            ));
        }
    }
    Err(TxtReadError::UnrecognizedFormat { line: line_number })
}

/// Errors in a text layout, preview, or full peak list.
#[derive(Debug)]
pub enum TxtReadError {
    Io(io::Error),
    InvalidSpec(&'static str),
    NoSampleData,
    UnrecognizedFormat {
        line: usize,
    },
    InvalidColumnCount {
        line: usize,
        expected: usize,
        actual: usize,
    },
    InvalidNumber {
        line: usize,
        column: usize,
        value: String,
        source: ParseFloatError,
    },
    InvalidPeak {
        line: usize,
        source: SpectrumError,
    },
}

impl fmt::Display for TxtReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(source) => write!(f, "failed to read text data: {source}"),
            Self::InvalidSpec(reason) => write!(f, "invalid text format spec: {reason}"),
            Self::NoSampleData => write!(
                f,
                "no data rows in the first {PREVIEW_LINES} lines; provide an explicit text format spec"
            ),
            Self::UnrecognizedFormat { line } => write!(
                f,
                "line {line}: cannot guess text format; provide an explicit text format spec"
            ),
            Self::InvalidColumnCount {
                line,
                expected,
                actual,
            } => write!(
                f,
                "line {line}: expected {expected} columns, found {actual}"
            ),
            Self::InvalidNumber {
                line,
                column,
                value,
                ..
            } => write!(
                f,
                "line {line}, column {column}: {value:?} is not a valid number"
            ),
            Self::InvalidPeak { line, source } => write!(f, "line {line}: invalid peak: {source}"),
        }
    }
}

impl Error for TxtReadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::InvalidNumber { source, .. } => Some(source),
            Self::InvalidPeak { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> TxtFormat {
        TxtFormat {
            delimiter: TxtDelimiter::Whitespace,
            skip_lines: 0,
            column_count: 2,
            mz_column: 0,
            intensity_column: 1,
            signal_to_noise_column: None,
            retention_time_column: None,
        }
    }

    #[test]
    fn guesses_and_reads_supported_layouts() {
        for (separator, delimiter) in [
            ("\t", TxtDelimiter::Character('\t')),
            (",", TxtDelimiter::Character(',')),
            (";", TxtDelimiter::Character(';')),
            ("|", TxtDelimiter::Character('|')),
            ("  ", TxtDelimiter::Whitespace),
        ] {
            let input = format!("202.85354{separator}917992{separator}0.00018\n");
            let spec = guess_txt_format(input.as_bytes()).unwrap();
            assert_eq!(spec.delimiter, delimiter);
            assert_eq!(spec.column_count, 3);
            assert_eq!(spec.skip_lines, 0);
            assert_eq!(spec.signal_to_noise_column, None);
            let spectrum = read(input.as_bytes(), &spec).unwrap();
            assert_eq!(spectrum.peaks()[0].mz(), 202.85354);
            assert_eq!(spectrum.peaks()[0].intensity(), 917_992.0);
            assert_eq!(spectrum.peaks()[0].signal_to_noise(), None);
        }
        let input = "2 2e6\n1 0\n2 500\n";
        let spec = guess_txt_format(input.as_bytes()).unwrap();
        let spectrum = read(input.as_bytes(), &spec).unwrap();
        assert_eq!(spectrum.peaks().len(), 3);
        assert_eq!(
            spectrum.peaks().iter().map(Peak::mz).collect::<Vec<_>>(),
            [2.0, 1.0, 2.0]
        );
        assert_eq!(spectrum.peaks()[0].intensity(), 2e6);
        assert_eq!(spectrum.peaks()[1].intensity(), 0.0);
        for sn_header in ["S/N", "SNR"] {
            let input = format!(
                "\u{feff}# export\r\n\r\nIntensity\tWidth\tm/z\t{sn_header}\r\n20\ttext\t2\t10\r\n"
            );
            let spec = guess_txt_format(input.as_bytes()).unwrap();
            assert_eq!(spec.skip_lines, 3);
            assert_eq!(spec.mz_column, 2);
            assert_eq!(spec.intensity_column, 0);
            assert_eq!(spec.signal_to_noise_column, Some(3));
            let spectrum = read(input.as_bytes(), &spec).unwrap();
            assert_eq!(
                spectrum.peaks()[0],
                Peak::new(2.0, 20.0, Some(10.0)).unwrap()
            );
        }
        for header in [
            "m/z,intensity,width",
            "M_Z,Abundance,resolution",
            "m/z,I,label",
            "m/z,intensity,signal-to-noise",
            "m/z,intensity,Signal to noise ratio",
        ] {
            let input = format!("{header}\n1,20,unknown\n");
            let spec = guess_txt_format(input.as_bytes()).unwrap();
            let spectrum = read(input.as_bytes(), &spec).unwrap();
            assert_eq!(spectrum.peaks()[0].signal_to_noise(), None);
        }
    }

    #[test]
    fn reads_explicit_layouts_and_ignores_nondata_lines() {
        let manual = TxtFormat {
            delimiter: TxtDelimiter::Character(':'),
            skip_lines: 2,
            column_count: 4,
            mz_column: 2,
            intensity_column: 0,
            signal_to_noise_column: Some(3),
            retention_time_column: None,
        };
        let spectrum = read(
            "arbitrary metadata\nnot a recognized header\n20:label:2:10\n".as_bytes(),
            &manual,
        )
        .unwrap();
        assert_eq!(
            spectrum.peaks()[0],
            Peak::new(2.0, 20.0, Some(10.0)).unwrap()
        );
        let input = "\u{feff}\n # comment\n2 20\n\n# another comment\n1 10\n";
        let guessed = guess_txt_format(input.as_bytes()).unwrap();
        assert_eq!(guessed.skip_lines, 2);
        assert_eq!(read(input.as_bytes(), &guessed).unwrap().peaks().len(), 2);
        let error = read("\n# comment\n2 bad\n".as_bytes(), &spec()).unwrap_err();
        assert!(matches!(
            error,
            TxtReadError::InvalidNumber {
                line: 3,
                column: 2,
                ..
            }
        ));
        assert_eq!(
            error.to_string(),
            "line 3, column 2: \"bad\" is not a valid number"
        );
        assert!(error.source().is_some());
    }

    #[test]
    fn preserves_retention_times_without_inferring_units_or_merging_peaks() {
        for header in ["Rt", "Retention time", "retention_time"] {
            let input = format!("{header},m/z,Charge,Intensity\n2.4,109,-128,100\n2.5,109,1,200\n");
            let spec = guess_txt_format(input.as_bytes()).unwrap();
            assert_eq!(spec.retention_time_column, Some(0));
            let spectrum = read(input.as_bytes(), &spec).unwrap();
            assert_eq!(spectrum.peaks()[0].retention_time(), Some(2.4));
            assert_eq!(spectrum.peaks()[1].retention_time(), Some(2.5));
            assert_eq!(spectrum.peaks()[1].intensity(), 200.0);
        }
        let spec = TxtFormat {
            column_count: 3,
            retention_time_column: Some(2),
            ..spec()
        };
        for value in ["-1", "NaN", "inf"] {
            let input = format!("43 100 {value}");
            assert!(matches!(
                read(input.as_bytes(), &spec),
                Err(TxtReadError::InvalidPeak {
                    line: 1,
                    source: SpectrumError::InvalidRetentionTime
                })
            ));
        }
        for column in [0, 1, 3] {
            let invalid = TxtFormat {
                retention_time_column: Some(column),
                ..spec.clone()
            };
            assert!(matches!(
                read("".as_bytes(), &invalid),
                Err(TxtReadError::InvalidSpec(_))
            ));
        }
        assert!(guess_txt_format("Rt,RT,m/z,Intensity\n1,2,43,100".as_bytes()).is_err());
        assert_eq!(
            guess_txt_format("43 100 2.4".as_bytes())
                .unwrap()
                .retention_time_column,
            None
        );
    }

    #[test]
    fn rejects_invalid_specs_and_peak_data() {
        for invalid in [
            TxtFormat {
                column_count: 0,
                ..spec()
            },
            TxtFormat {
                mz_column: 2,
                ..spec()
            },
            TxtFormat {
                intensity_column: 0,
                ..spec()
            },
            TxtFormat {
                signal_to_noise_column: Some(2),
                ..spec()
            },
            TxtFormat {
                signal_to_noise_column: Some(1),
                ..spec()
            },
            TxtFormat {
                delimiter: TxtDelimiter::Character('\n'),
                ..spec()
            },
        ] {
            assert!(matches!(
                read("".as_bytes(), &invalid),
                Err(TxtReadError::InvalidSpec(_))
            ));
        }
        let csv_spec = TxtFormat {
            delimiter: TxtDelimiter::Character(','),
            ..spec()
        };
        for (input, actual) in [("1\n", 1), ("1,2,3\n", 3)] {
            let error = read(input.as_bytes(), &csv_spec).unwrap_err();
            assert!(matches!(
                error,
                TxtReadError::InvalidColumnCount { line: 1, expected: 2, actual: count } if count == actual
            ));
        }
        for (input, column) in [(",2\n", 1), ("1,\n", 2)] {
            assert!(matches!(
                read(input.as_bytes(), &csv_spec),
                Err(TxtReadError::InvalidNumber { line: 1, column: actual, .. }) if actual == column
            ));
        }
        for (input, source) in [
            ("0 2", SpectrumError::InvalidMz),
            ("NaN 2", SpectrumError::InvalidMz),
            ("1 -2", SpectrumError::InvalidIntensity),
            ("1 inf", SpectrumError::InvalidIntensity),
        ] {
            assert!(matches!(
                read(input.as_bytes(), &spec()),
                Err(TxtReadError::InvalidPeak { line: 1, source: actual }) if actual == source
            ));
        }
        let spec = TxtFormat {
            column_count: 3,
            signal_to_noise_column: Some(2),
            ..spec()
        };
        for sn in ["-1", "NaN", "inf"] {
            assert!(matches!(
                read(format!("1 2 {sn}").as_bytes(), &spec),
                Err(TxtReadError::InvalidPeak {
                    source: SpectrumError::InvalidSignalToNoise,
                    ..
                })
            ));
        }
    }

    #[test]
    fn validates_previews_and_propagates_io_errors() {
        for input in ["", "\n# comment\n", "m/z,intensity\n"] {
            assert!(matches!(
                guess_txt_format(input.as_bytes()),
                Err(TxtReadError::NoSampleData)
            ));
        }
        for input in [
            "metadata\n1 2\n",
            "mass,width\n1,2\n",
            "m/z,mz,intensity\n1,2,3\n",
            "m/z,intensity,S/N,SNR\n1,2,3,4\n",
            "m/z\tintensity\tS/N\tSNR\n1\t2\t3\t4\n",
            "Mass-to-charge,Abundance,label\n1,20,unknown\n",
            "M_Z,Relative Intensity,resolution\n1,20,unknown\n",
            "bad 20\n1 2\n",
        ] {
            assert!(matches!(
                guess_txt_format(input.as_bytes()),
                Err(TxtReadError::UnrecognizedFormat { line: 1 })
            ));
        }
        assert!(matches!(
            guess_txt_format("1,20\n2,bad\n".as_bytes()),
            Err(TxtReadError::InvalidNumber {
                line: 2,
                column: 2,
                ..
            })
        ));
        assert!(matches!(
            guess_txt_format("1 20\n2 30 40\n".as_bytes()),
            Err(TxtReadError::InvalidColumnCount {
                line: 2,
                expected: 2,
                actual: 3
            })
        ));
        let input = format!("{}bad row\n", "1 20\n".repeat(PREVIEW_LINES));
        let mut preview = input.as_bytes();
        let guessed = guess_txt_format(&mut preview).unwrap();
        assert_eq!(preview, b"bad row\n");
        assert!(matches!(
            read(input.as_bytes(), &guessed),
            Err(TxtReadError::InvalidNumber {
                line: 33,
                column: 1,
                ..
            })
        ));
        let input = format!("{}1 20\n", "# comment\n".repeat(PREVIEW_LINES));
        assert!(matches!(
            guess_txt_format(input.as_bytes()),
            Err(TxtReadError::NoSampleData)
        ));
        assert!(read("".as_bytes(), &spec()).unwrap().peaks().is_empty());
        let failing_input = || BufReader::new(FailingRead);
        for error in [
            read(failing_input(), &spec()).unwrap_err(),
            guess_txt_format(failing_input()).unwrap_err(),
        ] {
            assert!(matches!(error, TxtReadError::Io(_)));
            assert!(error.source().is_some());
        }
    }

    struct FailingRead;

    impl Read for FailingRead {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("test I/O failure"))
        }
    }
}

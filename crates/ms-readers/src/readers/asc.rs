//! Reader for three-column ASC peak lists: m/z, intensity, and signal-to-noise.

use std::{
    error::Error,
    fmt,
    io::{self, BufRead, BufReader, Read},
    num::ParseFloatError,
};

use ms_core::spectrum::{MassSpectrum, Peak, SpectrumError};

/// Reads an ASC peak list with m/z, intensity, and signal-to-noise columns.
///
/// Columns may be separated by tabs or other whitespace. Blank lines are
/// ignored; every other line must contain exactly three numeric values.
/// Peak order and duplicate m/z values are preserved.
pub fn read<R: Read>(input: R) -> Result<MassSpectrum, AscReadError> {
    let mut peaks = Vec::new();

    for (index, line) in BufReader::new(input).lines().enumerate() {
        let line_number = index + 1;
        let line = line.map_err(AscReadError::Io)?;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let columns: Vec<_> = line.split_whitespace().collect();
        if columns.len() != 3 {
            return Err(AscReadError::InvalidColumnCount {
                line: line_number,
                actual: columns.len(),
            });
        }

        let parse_column = |column: usize| {
            columns[column]
                .parse::<f64>()
                .map_err(|source| AscReadError::InvalidNumber {
                    line: line_number,
                    column: column + 1,
                    value: columns[column].to_owned(),
                    source,
                })
        };

        let peak = Peak::new(parse_column(0)?, parse_column(1)?, Some(parse_column(2)?)).map_err(
            |source| AscReadError::InvalidPeak {
                line: line_number,
                source,
            },
        )?;
        peaks.push(peak);
    }

    Ok(MassSpectrum::new(peaks))
}

/// Errors encountered while reading an ASC peak list.
#[derive(Debug)]
pub enum AscReadError {
    Io(io::Error),
    InvalidColumnCount {
        line: usize,
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

impl fmt::Display for AscReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(source) => write!(f, "failed to read ASC data: {source}"),
            Self::InvalidColumnCount { line, actual } => write!(
                f,
                "line {line}: expected 3 columns (m/z, intensity, signal-to-noise), found {actual}"
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
            Self::InvalidPeak { line, source } => {
                write!(f, "line {line}: invalid peak: {source}")
            }
        }
    }
}

impl Error for AscReadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(source) => Some(source),
            Self::InvalidNumber { source, .. } => Some(source),
            Self::InvalidPeak { source, .. } => Some(source),
            Self::InvalidColumnCount { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    const SAMPLE: &str = "\
202.85354\t917992\t0.00018
203.07609\t965440\t0.00014
203.13359\t915962\t0.00014
204.09145\t981803\t0.00015
204.55546\t1842229\t0.00015
205.22296\t1232954\t0.00014
205.22317\t982774\t0.00011
205.24587\t1017086\t0.00014
";

    #[test]
    fn reads_tab_delimited_peak_list() {
        let spectrum = read(Cursor::new(SAMPLE)).unwrap();
        assert_eq!(spectrum.peaks().len(), 8);
        assert_eq!(spectrum.peaks()[0].mz(), 202.85354);
        assert_eq!(spectrum.peaks()[0].intensity(), 917_992.0);
        assert_eq!(spectrum.peaks()[0].signal_to_noise(), Some(0.00018));
        assert_eq!(spectrum.peaks()[7].mz(), 205.24587);
    }

    #[test]
    fn accepts_whitespace_and_blank_lines_and_preserves_order() {
        let spectrum = read(Cursor::new("2  20  0.2\n\n1\t10\t0.1\n")).unwrap();
        assert_eq!(
            spectrum.peaks().iter().map(Peak::mz).collect::<Vec<_>>(),
            [2.0, 1.0]
        );
    }

    #[test]
    fn reports_wrong_column_count_with_line_number() {
        let error = read(Cursor::new("1\t2\t3\n4\t5\n")).unwrap_err();
        assert!(matches!(
            error,
            AscReadError::InvalidColumnCount { line: 2, actual: 2 }
        ));
        assert_eq!(
            error.to_string(),
            "line 2: expected 3 columns (m/z, intensity, signal-to-noise), found 2"
        );
    }

    #[test]
    fn reports_invalid_number_with_line_and_column() {
        let error = read(Cursor::new("1\t2\t3\n4\tbad\t6\n")).unwrap_err();
        assert!(matches!(
            error,
            AscReadError::InvalidNumber {
                line: 2,
                column: 2,
                ..
            }
        ));
    }

    #[test]
    fn reports_invalid_peak_values_with_line_number() {
        let error = read(Cursor::new("0\t2\t3\n")).unwrap_err();
        assert!(matches!(
            error,
            AscReadError::InvalidPeak {
                line: 1,
                source: SpectrumError::InvalidMz
            }
        ));
    }
}

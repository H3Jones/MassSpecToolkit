//! Readers for spectra and assignment exports from mass-spectrometry software.
//!
//! Each reader is enabled by its own Cargo feature and converts its input into
//! the shared types provided by `ms-core`. The `txt` feature provides configurable
//! text peak lists and format guessing; `asc` retains the fixed three-column
//! m/z, intensity, and signal-to-noise reader.

pub mod readers;

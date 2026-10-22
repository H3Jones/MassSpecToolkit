//! Readers for assignment exports from mass-spectrometry software.
//!
//! Each software-specific reader will be enabled by its own Cargo feature and
//! will convert its input into the shared types provided by `ms-core`.

pub mod readers;

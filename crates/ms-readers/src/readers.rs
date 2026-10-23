//! Format-specific readers.
//!
//! Each reader is gated by its Cargo feature.

#[cfg(feature = "txt")]
pub mod txt;

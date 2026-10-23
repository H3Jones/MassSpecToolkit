#![cfg(feature = "txt")]

mod common;

use std::fs;

use common::fixture_path;

use ms_readers::readers::txt::{TxtDelimiter, TxtFormat, guess_txt_format, read};

#[test]
fn reads_da_asc_export_ignore_third_column() {
    let path = fixture_path().join("DA").join("asc_export.asc");
    let input = fs::read_to_string(path).expect("DA ASC fixture should be readable");

    let spec = guess_txt_format(input.as_bytes()).expect("DA ASC format should be recognized");
    assert_eq!(
        spec,
        TxtFormat {
            delimiter: TxtDelimiter::Character('\t'),
            skip_lines: 0,
            column_count: 3,
            mz_column: 0,
            intensity_column: 1,
            signal_to_noise_column: None,
        }
    );

    let spectrum = read(input.as_bytes(), &spec).expect("DA ASC fixture should parse");
    let expected = [
        (73.70965, 822_287.0),
        (73.78246, 840_652.0),
        (73.93599, 821_005.0),
        (74.04085, 816_471.0),
        (74.16178, 812_513.0),
        (74.27004, 829_836.0),
        (74.49305, 849_954.0),
        (74.51803, 838_856.0),
        (74.66697, 802_140.0),
        (74.70588, 801_806.0),
        (74.76754, 795_214.0),
        (74.77835, 834_843.0),
    ];
    assert_eq!(spectrum.peaks().len(), expected.len());
    for (peak, (mz, intensity)) in spectrum.peaks().iter().zip(expected) {
        assert_eq!(peak.mz(), mz);
        assert_eq!(peak.intensity(), intensity);
        assert_eq!(peak.signal_to_noise(), None);
    }
}

#[test]
fn reads_da_peak_list_csv() {
    let path = fixture_path().join("DA").join("peak_list.csv");
    let input = fs::read_to_string(path).expect("DA peak list CSV fixture should be readable");

    let spec =
        guess_txt_format(input.as_bytes()).expect("DA peak list CSV format should be recognized");
    assert_eq!(
        spec,
        TxtFormat {
            delimiter: TxtDelimiter::Character(','),
            skip_lines: 1,
            column_count: 3,
            mz_column: 0,
            intensity_column: 1,
            signal_to_noise_column: None,
        }
    );

    let spectrum = read(input.as_bytes(), &spec).expect("DA peak list CSV fixture should parse");
    let expected = [
        (202.68987, 454_818.0),
        (202.69008, 354_454.0),
        (202.69040, 473_045.0),
        (202.69099, 351_926.0),
        (202.69185, 327_745.0),
    ];
    assert_eq!(spectrum.peaks().len(), expected.len());
    for (peak, (mz, intensity)) in spectrum.peaks().iter().zip(expected) {
        assert_eq!(peak.mz(), mz);
        assert_eq!(peak.intensity(), intensity);
        assert_eq!(peak.signal_to_noise(), None);
    }
}

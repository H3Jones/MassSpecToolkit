#![cfg(feature = "txt")]

mod common;

use std::fs;

use common::fixture_path;

use ms_core::run::{RtMode, RtUnit, RtUnitOrigin, RunError, RunLayout};
use ms_readers::readers::txt::{
    TxtDelimiter, TxtFormat, TxtReadError, TxtReadOptions, guess_txt_format, read,
};

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
            retention_time_column: None,
        }
    );

    let run = read(
        input.as_bytes(),
        &spec,
        &TxtReadOptions::new("asc_export.asc"),
    )
    .expect("DA ASC fixture should parse");
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
    assert_eq!(run.peak_count(), expected.len());
    for (peak, (mz, intensity)) in run.peaks().zip(expected) {
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
            retention_time_column: None,
        }
    );

    let run = read(
        input.as_bytes(),
        &spec,
        &TxtReadOptions::new("peak_list.csv"),
    )
    .expect("DA peak list CSV fixture should parse");
    let expected = [
        (202.68987, 454_818.0),
        (202.69008, 354_454.0),
        (202.69040, 473_045.0),
        (202.69099, 351_926.0),
        (202.69185, 327_745.0),
    ];
    assert_eq!(run.peak_count(), expected.len());
    for (peak, (mz, intensity)) in run.peaks().zip(expected) {
        assert_eq!(peak.mz(), mz);
        assert_eq!(peak.intensity(), intensity);
        assert_eq!(peak.signal_to_noise(), None);
    }
}

#[test]
fn reads_rt_csv_as_flat_run_and_selects_rows() {
    let path = fixture_path().join("rt_peaks.csv");
    let input = fs::read_to_string(path).expect("RT CSV fixture should be readable");
    let spec = guess_txt_format(input.as_bytes()).unwrap();
    let run = read(
        input.as_bytes(),
        &spec,
        &TxtReadOptions::new("rt_peaks.csv"),
    )
    .unwrap();
    assert_eq!(run.layout(), RunLayout::Flat);
    assert_eq!(run.peak_ids(), Some([0, 1, 2, 3, 4].as_slice()));
    assert_eq!(run.source().reader_format, "txt");
    assert_eq!(run.source().source_id, "rt_peaks.csv");
    let unit = run.source().rt_unit.unwrap();
    assert_eq!(unit.input_unit(), RtUnit::Seconds);
    assert_eq!(unit.origin(), RtUnitOrigin::Default);
    let exact = run.get_rt_slice(5.5, RtMode::Exact).unwrap();
    assert_eq!(exact.peak_ids(), Some([1, 2].as_slice()));
    assert_eq!(exact.mz(), &[100.0, 200.0]);
    assert_eq!(exact.intensity(), &[250.0, 500.0]);
    assert_eq!(exact.source(), run.source());
    assert_eq!(run.get_rt_slice(5.6, RtMode::Nearest).unwrap(), exact);
    assert_eq!(run.get_rt_range(5.5, 6.0).unwrap(), exact);
}

#[test]
fn converts_caller_rt_units_to_seconds() {
    let input = "RT,m/z,intensity\n5.5,100,20\n5.5,200,30\n";
    let spec = guess_txt_format(input.as_bytes()).unwrap();
    let options = TxtReadOptions {
        rt_unit: Some(RtUnit::Minutes),
        ..TxtReadOptions::new("minutes.csv")
    };
    let run = read(input.as_bytes(), &spec, &options).unwrap();
    assert_eq!(run.source().rt_unit.unwrap().origin(), RtUnitOrigin::Caller);
    assert_eq!(run.peak_rt(), Some([Some(330.0), Some(330.0)].as_slice()));
    assert_eq!(run.peaks().next().unwrap().retention_time(), Some(330.0));
    assert_eq!(
        run.get_rt_slice(330.0, RtMode::Exact).unwrap().peak_ids(),
        Some([0, 1].as_slice())
    );
}

#[test]
fn preserves_empty_schema_and_reports_input_and_rt_errors() {
    let spec = TxtFormat {
        delimiter: TxtDelimiter::Character(','),
        skip_lines: 1,
        column_count: 3,
        mz_column: 1,
        intensity_column: 2,
        signal_to_noise_column: None,
        retention_time_column: Some(0),
    };
    let options = TxtReadOptions::default();
    let empty = read("RT,m/z,intensity\n".as_bytes(), &spec, &options).unwrap();
    assert!(empty.is_empty());
    assert!(empty.schema().has_rt);
    assert_eq!(empty.peak_rt(), Some([].as_slice()));
    for value in ["", "bad"] {
        let input = format!("RT,m/z,intensity\n{value},100,20\n");
        assert!(matches!(
            read(input.as_bytes(), &spec, &options),
            Err(TxtReadError::InvalidNumber {
                line: 2,
                column: 1,
                ..
            })
        ));
    }
    let minutes = TxtReadOptions {
        rt_unit: Some(RtUnit::Minutes),
        ..TxtReadOptions::default()
    };
    let input = format!("RT,m/z,intensity\n{},100,20\n", f64::MAX);
    assert!(matches!(
        read(input.as_bytes(), &spec, &minutes),
        Err(TxtReadError::Run(RunError::InvalidRt { row: 0, .. }))
    ));
    let no_rt = TxtFormat {
        delimiter: TxtDelimiter::Character(','),
        skip_lines: 0,
        column_count: 2,
        mz_column: 0,
        intensity_column: 1,
        signal_to_noise_column: None,
        retention_time_column: None,
    };
    let run = read("100,20\n".as_bytes(), &no_rt, &minutes).unwrap();
    assert_eq!(run.peak_rt(), None);
    assert_eq!(run.source().rt_unit, None);
    assert_eq!(
        run.get_rt_slice(1.0, RtMode::Exact),
        Err(RunError::RtUnavailable)
    );
}

use ms_core::spectrum::MassSpectrum;
use ms_readers::readers::txt::{TxtDelimiter, TxtFormat, TxtStreamReader, guess_txt_format, read};

fn streamed(input: &str, spec: Option<TxtFormat>, chunk_chars: usize) -> MassSpectrum {
    let mut reader = TxtStreamReader::new(spec).unwrap();
    let mut peaks = Vec::new();
    let chars: Vec<_> = input.chars().collect();
    for chunk in chars.chunks(chunk_chars) {
        peaks.extend(
            reader
                .push_chunk(&chunk.iter().collect::<String>())
                .unwrap(),
        );
    }
    peaks.extend(reader.finish().unwrap());
    assert!(reader.finish().is_err());
    assert!(reader.push_chunk("1 2\n").is_err());
    MassSpectrum::new(peaks)
}

#[test]
fn matches_complete_reader_at_every_character_boundary() {
    for input in [
        "\u{feff}# café\r\n\r\nRt,m/z,Intensity,S/N,Label\r\n0,57,0,0,α\r\n2.4,43,2e6,10,β\r\n2.4,57,5e-324,2,γ",
        "m/z\tintensity\n43\t1\n43\t2\n",
        "Intensity;m/z\n20;43\r\n30;57\r\n",
        "m/z|Intensity\n43|2\n",
        "57 0\n43 1\n57 2",
    ] {
        let spec = guess_txt_format(input.as_bytes()).unwrap();
        let expected = read(input.as_bytes(), &spec).unwrap();
        for width in 1..=input.chars().count() {
            let actual = streamed(input, None, width);
            assert_eq!(actual, expected);
            assert_eq!(actual.metadata("file.csv"), expected.metadata("file.csv"));
        }
    }
}

#[test]
fn preserves_explicit_preambles_and_empty_inputs() {
    let spec = TxtFormat {
        delimiter: TxtDelimiter::Character(':'),
        skip_lines: 2,
        column_count: 3,
        mz_column: 1,
        intensity_column: 0,
        signal_to_noise_column: None,
        retention_time_column: Some(2),
    };
    let input = "arbitrary metadata\nunrecognized header\n20:43:0\n10:57:1";
    assert_eq!(
        streamed(input, Some(spec.clone()), 1),
        read(input.as_bytes(), &spec).unwrap()
    );
    assert!(streamed("", Some(spec), 1).peaks().is_empty());
}

#[test]
fn preserves_preview_limit_and_physical_line_errors() {
    for input in [
        String::new(),
        "# comment\n".repeat(32) + "43 1\n",
        "# comment\n".repeat(31) + "m/z,intensity\n43,1\n",
        "\u{feff}\n# comment\nm/z,intensity\n43,bad".to_owned(),
        "43 1\n".repeat(20_000) + "\n# comment\n57 bad\n",
    ] {
        let expected = guess_txt_format(input.as_bytes())
            .and_then(|spec| read(input.as_bytes(), &spec))
            .unwrap_err()
            .to_string();
        let mut reader = TxtStreamReader::new(None).unwrap();
        let actual = input
            .chars()
            .try_for_each(|ch| reader.push_chunk(&ch.to_string()).map(|_| ()))
            .and_then(|_| reader.finish().map(|_| ()))
            .unwrap_err();
        assert_eq!(actual.to_string(), expected);
        assert!(reader.push_chunk("43 1\n").is_err());
    }
}

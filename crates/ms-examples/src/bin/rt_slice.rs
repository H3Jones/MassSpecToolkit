use std::{error::Error, fs::File, io::BufReader, path::Path};

use ms_core::run::{RtMode, Run};
use ms_readers::readers::txt::{TxtReadOptions, guess_txt_format, read};

fn main() -> Result<(), Box<dyn Error>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("rt_peaks.csv");
    // Guessing consumes its preview, so the file is opened again for reading.
    let format = guess_txt_format(BufReader::new(File::open(&path)?))?;
    let run = read(
        File::open(&path)?,
        &format,
        &TxtReadOptions::new("rt_peaks.csv"),
    )?;

    print_run("Full CSV", &run);
    print_run("Exact 5.5 s", &run.get_rt_slice(5.5, RtMode::Exact)?);
    print_run("Nearest 5.6 s", &run.get_rt_slice(5.6, RtMode::Nearest)?);
    print_run("Range [5.5, 6.0) s", &run.get_rt_range(5.5, 6.0)?);
    Ok(())
}

fn print_run(label: &str, run: &Run) {
    println!(
        "{label}: {} peaks, peak IDs {:?}, m/z {:?}, RT {:?}",
        run.peak_count(),
        run.peak_ids().unwrap_or_default(),
        run.mz(),
        run.peak_rt(),
    );
}

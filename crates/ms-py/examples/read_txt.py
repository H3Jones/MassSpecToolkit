import argparse
import json

from ms_py import Run


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read a text peak list and print it, or an RT selection, as JSON."
    )
    parser.add_argument("path", help="CSV/TSV/text peak list")
    parser.add_argument(
        "--rt-unit",
        choices=["seconds", "minutes", "milliseconds"],
        help="Unit of the file's RT column (default: seconds)",
    )
    parser.add_argument(
        "--rt",
        type=float,
        nargs=2,
        metavar=("MIN", "MAX"),
        help="Select peaks within these inclusive RT bounds, in seconds",
    )
    args = parser.parse_args()

    try:
        run = Run.from_text_file(args.path, rt_unit=args.rt_unit)
        if args.rt is not None:
            run = run.get_rt_slice(*args.rt)
    except (OSError, ValueError) as error:
        parser.error(str(error))

    summary = run.summary
    print(
        json.dumps(
            {
                "source_id": run.source.source_id,
                "peak_count": run.peak_count,
                "mz_bounds": summary.mz_bounds,
                "rt_bounds": summary.rt_bounds,
                "peaks": [
                    {
                        "peak_id": peak_id,
                        "mz": peak.mz,
                        "intensity": peak.intensity,
                        "signal_to_noise": peak.signal_to_noise,
                        "retention_time": peak.retention_time,
                    }
                    for peak_id, peak in zip(
                        run.peak_ids or [], run.peaks(), strict=True
                    )
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

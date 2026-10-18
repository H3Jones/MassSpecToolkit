import argparse
import json

import ms_py


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print a fine isotope distribution as JSON."
    )
    parser.add_argument("formula", help="Chemical formula, e.g. H2O or ^13CH4")
    parser.add_argument("--charge", type=int, default=0, help="Signed charge (default: 0)")
    parser.add_argument(
        "--coverage", type=float, default=0.9999, help="Probability coverage (default: 0.9999)"
    )
    parser.add_argument(
        "--max-states", type=int, default=200_000, help="State limit (default: 200000)"
    )
    args = parser.parse_args()

    try:
        result = ms_py.fine_isotope_distribution(
            args.formula,
            charge=args.charge,
            coverage=args.coverage,
            max_states=args.max_states,
        )
    except (ValueError, RuntimeError, OverflowError) as error:
        parser.error(str(error))

    print(
        json.dumps(
            {
                "charge": result.charge,
                "retained_probability": result.retained_probability,
                "peaks": [
                    {
                        "label": peak.label,
                        "mass": peak.mass,
                        "mass_to_charge": peak.mass_to_charge,
                        "abundance": peak.abundance,
                    }
                    for peak in result.peaks
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

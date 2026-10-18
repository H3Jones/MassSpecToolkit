import argparse
import json

import ms_py


def main() -> None:
    parser = argparse.ArgumentParser(description="Print a parsed formula result as JSON.")
    parser.add_argument("formula", help="Chemical formula, e.g. H2O or ^13CH4")
    args = parser.parse_args()

    try:
        result = ms_py.parse_formula(args.formula)
    except ValueError as error:
        parser.error(str(error))

    print(
        json.dumps(
            {
                "formula": result.formula,
                "mass": result.mass,
                "dbe": result.dbe,
                "atom_counts": [
                    {
                        "symbol": atom.symbol,
                        "mass_number": atom.mass_number,
                        "isotope_was_specified": atom.isotope_was_specified,
                        "atom_ram": atom.atom_ram,
                        "count": atom.count,
                        "total_mass": atom.total_mass,
                    }
                    for atom in result.atom_counts
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

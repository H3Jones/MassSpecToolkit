import json
from pathlib import Path
import subprocess
import sys
import unittest

import ms_py


EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


class ExampleTests(unittest.TestCase):
    def run_example(self, script: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(EXAMPLES / script), *args],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )

    def test_parse_formula(self) -> None:
        process = self.run_example("parse_formula.py", "H2O")
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual(set(result), {"formula", "mass", "dbe", "atom_counts"})
        self.assertEqual(result["formula"], "H2O")
        self.assertAlmostEqual(result["mass"], ms_py.parse_formula("H2O").mass)
        self.assertEqual(result["dbe"], 0)
        self.assertEqual(len(result["atom_counts"]), 2)
        self.assertEqual(
            result["atom_counts"][0],
            {
                "symbol": "H",
                "mass_number": 1,
                "isotope_was_specified": False,
                "atom_ram": 1.00782503223,
                "count": 2,
                "total_mass": 2 * 1.00782503223,
            },
        )

    def test_fixed_isotope(self) -> None:
        process = self.run_example("parse_formula.py", "^13CH4")
        self.assertEqual(process.returncode, 0, process.stderr)
        carbon = json.loads(process.stdout)["atom_counts"][0]
        self.assertEqual(carbon["mass_number"], 13)
        self.assertTrue(carbon["isotope_was_specified"])

    def test_isotope_distribution(self) -> None:
        for charge in [0, -2, 2]:
            with self.subTest(charge=charge):
                process = self.run_example(
                    "isotope_distribution.py",
                    "H2O",
                    "--charge",
                    str(charge),
                    "--coverage",
                    "1",
                )
                self.assertEqual(process.returncode, 0, process.stderr)
                result = json.loads(process.stdout)
                self.assertEqual(
                    set(result), {"charge", "retained_probability", "peaks"}
                )
                self.assertEqual(result["charge"], charge)
                self.assertAlmostEqual(result["retained_probability"], 1)
                self.assertEqual(len(result["peaks"]), 9)
                peak = result["peaks"][0]
                self.assertEqual(
                    set(peak), {"label", "mass", "mass_to_charge", "abundance"}
                )
                self.assertEqual(peak["label"], "1H2 16O")
                self.assertAlmostEqual(peak["mass"], ms_py.evaluate_ion("H2O", charge).mass)
                if charge:
                    self.assertAlmostEqual(peak["mass_to_charge"], peak["mass"] / 2)
                else:
                    self.assertIsNone(peak["mass_to_charge"])
                self.assertAlmostEqual(sum(p["abundance"] for p in result["peaks"]), 1)

    def test_default_distribution(self) -> None:
        process = self.run_example("isotope_distribution.py", "C10H20O5")
        self.assertEqual(process.returncode, 0, process.stderr)
        result = json.loads(process.stdout)
        self.assertEqual(result["charge"], 0)
        self.assertGreaterEqual(result["retained_probability"], 0.9999)

    def test_cli_errors(self) -> None:
        cases = [
            ("parse_formula.py", (), "required"),
            ("parse_formula.py", ("not a formula",), "error:"),
            ("isotope_distribution.py", (), "required"),
            ("isotope_distribution.py", ("not a formula",), "error:"),
            ("isotope_distribution.py", ("H2O", "--charge", "256"), "255"),
            ("isotope_distribution.py", ("H2O", "--charge", str(2**40)), "error:"),
            ("isotope_distribution.py", ("H2O", "--coverage", "0"), "coverage"),
            ("isotope_distribution.py", ("H2O", "--max-states", "0"), "max_states"),
            (
                "isotope_distribution.py",
                ("H2O", "--coverage", "1", "--max-states", "1"),
                "1 states",
            ),
        ]
        for script, args, message in cases:
            with self.subTest(script=script, args=args):
                process = self.run_example(script, *args)
                self.assertEqual(process.returncode, 2)
                self.assertEqual(process.stdout, "")
                self.assertIn(message, process.stderr)
                self.assertNotIn("Traceback", process.stderr)


if __name__ == "__main__":
    unittest.main()

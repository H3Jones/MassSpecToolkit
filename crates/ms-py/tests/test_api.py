import math
import unittest
from importlib.metadata import version
from importlib.resources import files

import ms_py


WATER_MASS = 2 * 1.00782503223 + 15.99491461957


class ApiTests(unittest.TestCase):
    def test_package_metadata(self) -> None:
        self.assertEqual(ms_py.__version__, version("ms-py"))
        self.assertAlmostEqual(ms_py.ELECTRON_MASS, 0.000548579909065)
        self.assertTrue(files(ms_py).joinpath("__init__.pyi").is_file())
        self.assertTrue(files(ms_py).joinpath("py.typed").is_file())

    def test_parse_formula(self) -> None:
        result = ms_py.parse_formula("OH2")
        self.assertIsInstance(result, ms_py.FormulaResult)
        self.assertEqual(result.formula, "OH2")
        self.assertAlmostEqual(result.mass, WATER_MASS, places=10)
        self.assertEqual(result.dbe, 0)
        self.assertEqual([atom.symbol for atom in result.atom_counts], ["O", "H"])
        hydrogen = result.atom_counts[1]
        self.assertIsInstance(hydrogen, ms_py.AtomCount)
        self.assertEqual(hydrogen.mass_number, 1)
        self.assertEqual(hydrogen.count, 2)
        self.assertFalse(hydrogen.isotope_was_specified)
        self.assertAlmostEqual(hydrogen.total_mass, 2 * hydrogen.atom_ram)
        with self.assertRaises(AttributeError):
            setattr(result, "mass", 0)
        result.atom_counts.clear()
        self.assertEqual(len(result.atom_counts), 2)

    def test_fixed_isotope(self) -> None:
        result = ms_py.parse_formula("^13CH4")
        carbon = result.atom_counts[0]
        self.assertEqual(carbon.symbol, "C")
        self.assertEqual(carbon.mass_number, 13)
        self.assertTrue(carbon.isotope_was_specified)
        self.assertAlmostEqual(result.mass, 13.00335483507 + 4 * 1.00782503223)

    def test_ions(self) -> None:
        for charge in [-255, -2, -1, 0, 1, 2, 255]:
            with self.subTest(charge=charge):
                ion = ms_py.evaluate_ion("H2O", charge)
                self.assertIsInstance(ion, ms_py.IonResult)
                self.assertEqual(ion.charge, charge)
                self.assertEqual(ion.formula, "H2O")
                self.assertEqual(ion.dbe, 0)
                self.assertEqual(len(ion.atom_counts), 2)
                self.assertAlmostEqual(
                    ion.mass, WATER_MASS - charge * ms_py.ELECTRON_MASS
                )
                if charge:
                    self.assertIsNotNone(ion.mass_to_charge)
                    self.assertAlmostEqual(ion.mass_to_charge, ion.mass / abs(charge))
                else:
                    self.assertIsNone(ion.mass_to_charge)
        self.assertIsNone(ms_py.evaluate_ion("H2O").mass_to_charge)

    def test_mass_split(self) -> None:
        result = ms_py.mass_split("C2H6O", "CH4")
        self.assertIsInstance(result, ms_py.MassSplitResult)
        self.assertEqual(result.formula_a.formula, "C2H6O")
        self.assertEqual(result.formula_b.formula, "CH4")
        self.assertIsNotNone(result.formula_a_only)
        self.assertEqual(result.formula_a_only.formula, "CH2O")
        self.assertIsNone(result.formula_b_only)
        self.assertAlmostEqual(
            result.mass_difference, result.formula_a.mass - result.formula_b.mass
        )
        reverse = ms_py.mass_split("CH4", "C2H6O")
        self.assertIsNone(reverse.formula_a_only)
        self.assertEqual(reverse.formula_b_only.formula, "CH2O")
        self.assertEqual(reverse.mass_difference, -result.mass_difference)
        identical = ms_py.mass_split("H2O", "H2O")
        self.assertIsNone(identical.formula_a_only)
        self.assertIsNone(identical.formula_b_only)
        self.assertEqual(math.copysign(1, identical.mass_difference), 1)
        self.assertEqual(identical.mass_difference, 0)

    def test_full_distribution_and_charge_correction(self) -> None:
        neutral = ms_py.fine_isotope_distribution("H2O", coverage=1)
        self.assertIsInstance(neutral, ms_py.FineIsotopeDistributionResult)
        self.assertEqual(neutral.charge, 0)
        self.assertEqual(len(neutral.peaks), 9)
        self.assertAlmostEqual(neutral.retained_probability, 1)
        self.assertAlmostEqual(sum(p.abundance for p in neutral.peaks), 1)
        self.assertEqual(neutral.peaks[0].label, "1H2 16O")
        self.assertAlmostEqual(neutral.peaks[0].mass, WATER_MASS)
        self.assertIsNone(neutral.peaks[0].mass_to_charge)
        self.assertEqual(
            [p.mass for p in neutral.peaks], sorted(p.mass for p in neutral.peaks)
        )
        for charge in [-2, 2]:
            charged = ms_py.fine_isotope_distribution("H2O", charge, coverage=1)
            for original, peak in zip(neutral.peaks, charged.peaks, strict=True):
                self.assertIsInstance(peak, ms_py.FineIsotopePeakResult)
                self.assertEqual(peak.label, original.label)
                self.assertEqual(peak.abundance, original.abundance)
                self.assertAlmostEqual(
                    peak.mass, original.mass - charge * ms_py.ELECTRON_MASS
                )
                self.assertAlmostEqual(peak.mass_to_charge, peak.mass / 2)

    def test_pruned_and_fixed_distributions(self) -> None:
        result = ms_py.fine_isotope_distribution("C10H20O5")
        self.assertGreaterEqual(result.retained_probability, 0.9999)
        self.assertAlmostEqual(
            result.retained_probability, sum(p.abundance for p in result.peaks)
        )
        fixed = ms_py.fine_isotope_distribution("^13C", coverage=1)
        self.assertEqual(len(fixed.peaks), 1)
        self.assertEqual(fixed.peaks[0].label, "13C")
        self.assertEqual(fixed.peaks[0].abundance, 1)
        self.assertAlmostEqual(fixed.peaks[0].mass, 13.00335483507)

    def test_invalid_formulas(self) -> None:
        for function in [
            ms_py.parse_formula,
            ms_py.evaluate_ion,
            ms_py.fine_isotope_distribution,
        ]:
            with self.subTest(function=function.__name__):
                with self.assertRaises(ValueError):
                    function("not a formula")
        for a, b in [("bad", "H2O"), ("H2O", "bad")]:
            with self.assertRaises(ValueError):
                ms_py.mass_split(a, b)
        with self.assertRaises(TypeError):
            ms_py.parse_formula(None)

    def test_invalid_charges(self) -> None:
        for function in [ms_py.evaluate_ion, ms_py.fine_isotope_distribution]:
            for charge in [-256, 256, -(2**31)]:
                with self.subTest(function=function.__name__, charge=charge):
                    with self.assertRaisesRegex(ValueError, "255"):
                        function("H2O", charge)
            with self.assertRaises(OverflowError):
                function("H2O", 2**40)

    def test_invalid_distribution_options(self) -> None:
        for coverage in [0, -1, 1.1, math.nan, math.inf]:
            with self.subTest(coverage=coverage):
                with self.assertRaisesRegex(ValueError, "coverage"):
                    ms_py.fine_isotope_distribution("H2O", coverage=coverage)
        with self.assertRaisesRegex(ValueError, "max_states"):
            ms_py.fine_isotope_distribution("H2O", max_states=0)
        with self.assertRaisesRegex(
            RuntimeError,
            r"1 states \(best coverage at this step: 0\.999885, 99\.99%\)",
        ):
            ms_py.fine_isotope_distribution("H2O", coverage=1, max_states=1)
        with self.assertRaisesRegex(ValueError, "no most-abundant isotope"):
            ms_py.fine_isotope_distribution("Tc")


if __name__ == "__main__":
    unittest.main()

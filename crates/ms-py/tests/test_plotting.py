import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import ms_py

FIXTURES = Path(__file__).resolve().parents[2] / "ms-readers" / "tests" / "fixtures"
RT_PEAKS = FIXTURES / "rt_peaks.csv"

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import seaborn.objects as so
except ImportError:
    so = None


class OptionalDependencyTests(unittest.TestCase):
    def test_reading_works_without_seaborn(self) -> None:
        script = textwrap.dedent(
            f"""
            import sys
            sys.modules["seaborn"] = None
            from ms_py import Run
            run = Run.from_text_file({str(RT_PEAKS)!r})
            assert len(run.mz) == 5
            try:
                run.get_rt_slice(5.5, 5.5).plot_spectrum()
            except ImportError as error:
                print(error)
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True, check=True
        )
        self.assertIn("pip install ms-py[plot]", result.stdout)

    def test_reading_does_not_import_seaborn(self) -> None:
        script = (
            "import sys; from ms_py import Run; "
            f"Run.from_text_file({str(RT_PEAKS)!r}); "
            "print('seaborn' in sys.modules)"
        )
        result = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True, check=True
        )
        self.assertEqual(result.stdout.strip(), "False")

    def test_tic_calculation_works_without_seaborn(self) -> None:
        script = textwrap.dedent(
            f"""
            import sys
            sys.modules["seaborn"] = None
            from ms_py import Run
            run = Run.from_text_file({str(RT_PEAKS)!r})
            assert run.calculate_tic() == (
                [0.0, 5.5, 6.0, 7.0], [0.0, 750.0, 400.0, 125.0]
            )
            assert "matplotlib" not in sys.modules
            try:
                run.plot_tic()
            except ImportError as error:
                print(error)
            else:
                raise AssertionError("plot_tic should require seaborn")
            """
        )
        result = subprocess.run(
            [sys.executable, "-c", script], capture_output=True, text=True, check=True
        )
        self.assertIn("pip install ms-py[plot]", result.stdout)


class TicTests(unittest.TestCase):
    def setUp(self) -> None:
        self.run = ms_py.Run.from_text_file(RT_PEAKS)

    def test_calculation_groups_sorts_and_preserves_input(self) -> None:
        self.assertEqual(
            self.run.calculate_tic(),
            ([0.0, 5.5, 6.0, 7.0], [0.0, 750.0, 400.0, 125.0]),
        )
        self.assertEqual(self.run.peak_rt, [6.0, 5.5, 5.5, 7.0, 0.0])
        self.assertEqual(
            self.run.get_rt_slice(5.5, 6.0).calculate_tic(),
            ([5.5, 6.0], [750.0, 400.0]),
        )
        self.assertEqual(self.run.get_rt_slice(1.0, 2.0).calculate_tic(), ([], []))
        minutes = ms_py.Run.from_text_file(RT_PEAKS, rt_unit="minutes")
        self.assertEqual(
            minutes.calculate_tic(),
            ([0.0, 330.0, 360.0, 420.0], [0.0, 750.0, 400.0, 125.0]),
        )

    def test_calculation_requires_complete_rt(self) -> None:
        from ms_py.plotting import calculate_tic

        layout = ms_py.TxtFormat(
            skip_lines=1, column_count=4, mz_column=1, intensity_column=2
        )
        no_rt = ms_py.Run.from_text_file(RT_PEAKS, layout)
        for calculate_or_plot in [no_rt.calculate_tic, no_rt.plot_tic]:
            with self.assertRaisesRegex(ValueError, "retention times"):
                calculate_or_plot()
        missing_rt = SimpleNamespace(peak_rt=[1.0, None], intensity=[10.0, 20.0])
        with self.assertRaisesRegex(ValueError, "every peak"):
            calculate_tic(missing_rt)

    def test_calculation_rejects_overflow(self) -> None:
        from ms_py.plotting import calculate_tic

        run = SimpleNamespace(peak_rt=[1.0, 1.0], intensity=[1e308, 1e308])
        with self.assertRaisesRegex(OverflowError, "total ion intensity"):
            calculate_tic(run)


@unittest.skipIf(so is None, "plotting dependencies are not installed")
class PlotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.run = ms_py.Run.from_text_file(RT_PEAKS)
        self.slice = self.run.get_rt_slice(5.5, 5.5)
        plt.close("all")
        self.addCleanup(plt.close, "all")

    def draw(self, plot):
        _, ax = plt.subplots()
        plot.on(ax).plot()
        return ax

    def test_returns_unrendered_plot(self) -> None:
        plot = self.slice.plot_spectrum()
        self.assertIsInstance(plot, so.Plot)
        self.assertEqual(plt.get_fignums(), [])

    def test_sticks_draw_each_peak_from_zero_on_existing_axes(self) -> None:
        ax = self.draw(self.slice.plot_spectrum().label(title="edited"))
        segments = [s.tolist() for s in ax.collections[0].get_segments()]
        self.assertEqual(
            segments, [[[100.0, 0.0], [100.0, 250.0]], [[200.0, 0.0], [200.0, 500.0]]]
        )
        self.assertEqual(ax.get_title(), "edited")

    def test_duplicate_measurements_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "duplicates.csv"
            path.write_text("m/z,intensity\n100.0,10.0\n100.0,30.0\n200.0,5.0\n")
            run = ms_py.Run.from_text_file(path)

        sticks = self.draw(run.plot_spectrum()).collections[0].get_segments()
        self.assertEqual(
            [s[1].tolist() for s in sticks],
            [[100.0, 10.0], [100.0, 30.0], [200.0, 5.0]],
        )

        profile = self.draw(run.plot_spectrum(style="profile")).lines[0].get_xydata()
        self.assertEqual(
            sorted(map(tuple, profile.tolist())),
            [(100.0, 10.0), (100.0, 30.0), (200.0, 5.0)],
        )

    def test_binned_spectrum_selects_strongest_and_reports_counts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "peaks.csv"
            path.write_text(
                "m/z,intensity\n5,7\n0.2,4\n0.1,8\n0.15,8\n2.5,3\n10,9\n10,8\n11,1\n"
            )
            run = ms_py.Run.from_text_file(path)

        plot = run.plot_spectrum(bins=4, mz_range=(0, 10))
        self.assertIsInstance(plot, so.Plot)
        ax = self.draw(plot)
        segments = [segment[1].tolist() for segment in ax.collections[0].get_segments()]
        self.assertEqual(segments, [[5.0, 7.0], [0.1, 8.0], [2.5, 3.0], [10.0, 9.0]])
        self.assertEqual(ax.get_xlim(), (0, 10))
        self.assertEqual(ax.get_title(), "Showing 4 of 7 peaks in range (8 total)")
        self.assertEqual(run.peak_count, 8)

        zoomed = self.draw(run.plot_spectrum(bins=4, mz_range=(0, 0.25)))
        self.assertEqual(len(zoomed.collections[0].get_segments()), 3)
        self.assertEqual(zoomed.get_title(), "Showing 3 of 3 peaks in range (8 total)")

        empty = self.draw(run.plot_spectrum(bins=4, mz_range=(20, 30)))
        self.assertEqual(sum(len(c.get_segments()) for c in empty.collections), 0)
        self.assertEqual(empty.get_title(), "Showing 0 of 0 peaks in range (8 total)")

    def test_binned_spectrum_validates_options(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive"):
            self.slice.plot_spectrum(bins=0)
        with self.assertRaisesRegex(ValueError, "requires bins"):
            self.slice.plot_spectrum(mz_range=(0, 100))
        with self.assertRaisesRegex(ValueError, "only supported"):
            self.slice.plot_spectrum(style="profile", bins=10)
        for mz_range in [(1, 1), (2, 1), (0, float("inf")), (float("nan"), 1)]:
            with self.subTest(mz_range=mz_range):
                with self.assertRaisesRegex(ValueError, "finite and increasing"):
                    self.slice.plot_spectrum(bins=10, mz_range=mz_range)

    def test_binned_spectrum_caps_bin_count(self) -> None:
        from ms_py.plotting import _binned_spectrum

        mz = list(range(1, 2001))
        selected, _, visible_count, _ = _binned_spectrum(mz, mz, 2000, (0, 2000))
        self.assertEqual(visible_count, 2000)
        self.assertEqual(len(selected), 1000)

    def test_multi_rt_spectrum_requires_selection(self) -> None:
        with self.assertRaisesRegex(ValueError, "get_rt_slice"):
            self.run.plot_spectrum()

    def test_invalid_style(self) -> None:
        with self.assertRaisesRegex(ValueError, "style"):
            self.slice.plot_spectrum(style="bars")

    def test_tic_plots_totals_in_rt_order(self) -> None:
        ax = self.draw(self.run.plot_tic())
        self.assertEqual(
            ax.lines[0].get_xydata().tolist(),
            [[0.0, 0.0], [5.5, 750.0], [6.0, 400.0], [7.0, 125.0]],
        )
        self.assertEqual((ax.get_xlabel(), ax.get_ylabel()), ("RT (s)", "Intensity"))
        empty = self.draw(self.run.get_rt_slice(1.0, 2.0).plot_tic())
        self.assertEqual(len(empty.lines), 0)

    def test_tic_uses_calculation_and_returns_unrendered_plot(self) -> None:
        with patch(
            "ms_py.plotting.calculate_tic", return_value=([1.0, 2.0], [10.0, 20.0])
        ) as calculate:
            plot = self.run.plot_tic()
        calculate.assert_called_once_with(self.run)
        self.assertIsInstance(plot, so.Plot)
        self.assertEqual(plt.get_fignums(), [])
        self.assertEqual(
            self.draw(plot).lines[0].get_xydata().tolist(),
            [[1.0, 10.0], [2.0, 20.0]],
        )

    def test_rt_mz_plots_every_peak(self) -> None:
        ax = self.draw(self.run.plot_rt_mz())
        self.assertEqual(
            ax.collections[0].get_offsets().tolist(),
            [[6.0, 300.0], [5.5, 100.0], [5.5, 200.0], [7.0, 100.0], [0.0, 50.0]],
        )

    def test_rt_mz_requires_peak_rt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "no_rt.csv"
            path.write_text("m/z,intensity\n100.0,10.0\n")
            run = ms_py.Run.from_text_file(path)
        with self.assertRaisesRegex(ValueError, "retention times"):
            run.plot_rt_mz()


if __name__ == "__main__":
    unittest.main()

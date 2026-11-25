import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

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
                run.get_rt_slice(5.5, mode="exact").plot_spectrum()
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


@unittest.skipIf(so is None, "plotting dependencies are not installed")
class PlotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.run = ms_py.Run.from_text_file(RT_PEAKS)
        self.slice = self.run.get_rt_slice(5.5, mode="exact")
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

    def test_multi_rt_spectrum_requires_selection(self) -> None:
        with self.assertRaisesRegex(ValueError, "get_rt_slice"):
            self.run.plot_spectrum()

    def test_invalid_style(self) -> None:
        with self.assertRaisesRegex(ValueError, "style"):
            self.slice.plot_spectrum(style="bars")

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

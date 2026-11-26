import unittest
from pathlib import Path

import ms_py

FIXTURES = Path(__file__).resolve().parents[2] / "ms-readers" / "tests" / "fixtures"
RT_PEAKS = FIXTURES / "rt_peaks.csv"


class ReadTxtTests(unittest.TestCase):
    def test_from_text_file(self) -> None:
        run = ms_py.Run.from_text_file(RT_PEAKS)
        self.assertIsInstance(run, ms_py.Run)
        self.assertEqual(run.peak_ids, [0, 1, 2, 3, 4])
        self.assertEqual(run.peak_rt, [6.0, 5.5, 5.5, 7.0, 0.0])
        self.assertEqual(run.source.source_id, "rt_peaks.csv")
        self.assertEqual(run.source.rt_unit_origin, "default")

        layout = ms_py.TxtFormat(
            skip_lines=1,
            column_count=4,
            mz_column=1,
            intensity_column=2,
            retention_time_column=0,
            signal_to_noise_column=3,
        )
        explicit = ms_py.Run.from_text_file(
            str(RT_PEAKS), format=layout, rt_unit="minutes", source_id="sample"
        )
        self.assertEqual(explicit.mz, run.mz)
        self.assertEqual(explicit.intensity, run.intensity)
        self.assertEqual(explicit.signal_to_noise, run.signal_to_noise)
        self.assertEqual(explicit.peak_rt, [360.0, 330.0, 330.0, 420.0, 0.0])
        self.assertEqual(explicit.source.source_id, "sample")
        self.assertEqual(explicit.source.rt_unit_origin, "caller")
        self.assertEqual(explicit.get_rt_slice(330.0, mode="exact").peak_ids, [1, 2])

    def test_from_text_file_errors(self) -> None:
        with self.assertRaises(FileNotFoundError):
            ms_py.Run.from_text_file(FIXTURES / "missing.csv")
        with self.assertRaisesRegex(ValueError, "hours"):
            ms_py.Run.from_text_file(RT_PEAKS, rt_unit="hours")
        wrong_count = ms_py.TxtFormat(
            skip_lines=1, column_count=3, mz_column=1, intensity_column=2
        )
        with self.assertRaisesRegex(ValueError, "line 2"):
            ms_py.Run.from_text_file(RT_PEAKS, wrong_count)

    def test_guess_and_read_rt_csv(self) -> None:
        guessed = ms_py.guess_txt_format(RT_PEAKS)
        self.assertEqual(guessed.delimiter, ",")
        self.assertEqual(guessed.skip_lines, 1)
        self.assertEqual(
            (
                guessed.retention_time_column,
                guessed.mz_column,
                guessed.intensity_column,
            ),
            (0, 1, 2),
        )
        self.assertEqual(guessed.signal_to_noise_column, 3)

        run = ms_py.read_txt(str(RT_PEAKS))
        self.assertEqual(run.layout, "flat")
        self.assertEqual(run.peak_count, 5)
        self.assertIsNone(run.scan_count)
        self.assertEqual(run.peak_ids, [0, 1, 2, 3, 4])
        self.assertEqual(run.mz, [300.0, 100.0, 200.0, 100.0, 50.0])
        self.assertEqual(run.peak_rt, [6.0, 5.5, 5.5, 7.0, 0.0])
        self.assertEqual(run.signal_to_noise, [20.0, 10.0, 30.0, 5.0, 0.0])
        schema = run.schema
        self.assertEqual(
            (schema.layout, schema.has_rt, schema.has_signal_to_noise),
            ("flat", True, True),
        )
        source = run.source
        self.assertEqual(
            (source.source_id, source.filename, source.reader_format),
            ("rt_peaks.csv",) * 2 + ("txt",),
        )
        self.assertEqual(
            (source.rt_unit, source.rt_unit_origin, source.declared_rt_unit),
            ("seconds", "default", None),
        )
        summary = run.summary
        self.assertEqual(summary.peak_count, 5)
        self.assertEqual(summary.mz_bounds, (50.0, 300.0))
        self.assertEqual(summary.rt_bounds, (0.0, 7.0))
        peak = run.peak(1)
        self.assertIsInstance(peak, ms_py.Peak)
        self.assertEqual(
            (peak.mz, peak.intensity, peak.signal_to_noise, peak.retention_time),
            (100.0, 250.0, 10.0, 5.5),
        )
        self.assertEqual([p.mz for p in run.peaks()], run.mz)
        with self.assertRaises(IndexError):
            run.peak(5)

    def test_rt_selections(self) -> None:
        run = ms_py.read_txt(RT_PEAKS)
        for selected in [
            run.get_rt_slice(5.5, mode="exact"),
            run.get_rt_slice(5.6, mode="nearest"),
            run.get_rt_range(5.5, 6.0),
        ]:
            self.assertEqual(selected.peak_ids, [1, 2])
            self.assertEqual(selected.mz, [100.0, 200.0])
            self.assertEqual(selected.source.source_id, "rt_peaks.csv")
        empty = run.get_rt_slice(5.6, mode="exact")
        self.assertTrue(empty.is_empty)
        self.assertEqual(empty.peak_rt, [])
        self.assertIsNone(empty.summary.mz_bounds)
        self.assertEqual(run.get_rt_slice(5.75, mode="nearest").peak_ids, [1, 2])
        with self.assertRaisesRegex(ValueError, "mode"):
            run.get_rt_slice(5.5, mode="closest")
        with self.assertRaises(TypeError):
            run.get_rt_slice(5.5)  # type: ignore[call-arg]
        with self.assertRaises(ValueError):
            run.get_rt_range(6.0, 5.0)
        with self.assertRaises(ValueError):
            run.get_ms_level(1)

    def test_rt_unit_conversion(self) -> None:
        run = ms_py.read_txt(RT_PEAKS, rt_unit="minutes", source_id="sample")
        self.assertEqual(run.peak_rt, [360.0, 330.0, 330.0, 420.0, 0.0])
        self.assertEqual(run.source.source_id, "sample")
        self.assertEqual(
            (run.source.rt_unit, run.source.rt_unit_origin), ("minutes", "caller")
        )
        self.assertEqual(run.get_rt_slice(330.0, mode="exact").peak_ids, [1, 2])
        with self.assertRaisesRegex(ValueError, "hours"):
            ms_py.read_txt(RT_PEAKS, rt_unit="hours")

    def test_peak_slices(self) -> None:
        run = ms_py.Run.from_text_file(RT_PEAKS)
        selected = run.get_mz_slice(100, 200)
        self.assertEqual(selected.peak_ids, [1, 2, 3])
        self.assertEqual(selected.mz, [100.0, 200.0, 100.0])
        self.assertEqual(selected.peak_rt, [5.5, 5.5, 7.0])
        self.assertEqual(selected.signal_to_noise, [10.0, 30.0, 5.0])
        self.assertEqual(selected.source.source_id, run.source.source_id)
        self.assertEqual(selected.summary.mz_bounds, (100.0, 200.0))
        self.assertEqual(selected.get_intensity_slice(250, 500).peak_ids, [1, 2])
        self.assertEqual(run.get_mz_slice(100, 100).peak_ids, [1, 3])
        self.assertEqual(run.get_intensity_slice(0, 0).peak_ids, [4])
        empty = run.get_mz_slice(400, 500)
        self.assertTrue(empty.is_empty)
        self.assertEqual(empty.peak_rt, [])
        self.assertIsNone(empty.summary.mz_bounds)
        self.assertEqual(run.peak_count, 5)

    def test_peak_slice_bounds(self) -> None:
        run = ms_py.Run.from_text_file(RT_PEAKS)
        for select in [run.get_mz_slice, run.get_intensity_slice]:
            for minimum, maximum in [
                (float("nan"), 1),
                (0, float("inf")),
                (-1, 1),
                (2, 1),
            ]:
                with self.subTest(method=select, bounds=(minimum, maximum)):
                    with self.assertRaisesRegex(
                        ValueError, "finite, nonnegative and ordered"
                    ):
                        select(minimum, maximum)

    def test_invalid_input(self) -> None:
        with self.assertRaises(FileNotFoundError):
            ms_py.read_txt(FIXTURES / "missing.csv")
        with self.assertRaisesRegex(ValueError, "delimiter"):
            ms_py.TxtFormat(
                column_count=2, mz_column=0, intensity_column=1, delimiter=",,"
            )
        with self.assertRaisesRegex(ValueError, "column"):
            ms_py.TxtFormat(column_count=2, mz_column=0, intensity_column=2)
        with self.assertRaisesRegex(ValueError, "distinct"):
            ms_py.TxtFormat(column_count=2, mz_column=0, intensity_column=0)
        wrong_count = ms_py.TxtFormat(
            skip_lines=1, column_count=3, mz_column=1, intensity_column=2
        )
        with self.assertRaisesRegex(ValueError, "line 2"):
            ms_py.read_txt(RT_PEAKS, wrong_count)


if __name__ == "__main__":
    unittest.main()

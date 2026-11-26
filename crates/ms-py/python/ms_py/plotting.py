"""Seaborn plot builders for ``ms_py.Run``.

Loaded on the first plot call, so reading data never imports seaborn. Builders
return an unrendered ``seaborn.objects.Plot``.
"""

import math

_MAX_SPECTRUM_BINS = 1_000


def _objects():
    try:
        import seaborn.objects as so
    except ImportError as error:
        raise ImportError(
            "plotting requires seaborn; install it with `pip install ms-py[plot]`"
        ) from error
    return so


def _require_single_spectrum(run):
    if run.layout == "scans":
        if run.scan_count != 1:
            raise ValueError(
                f"run contains {run.scan_count} scans; select one with "
                "get_rt_slice() before plotting a spectrum"
            )
        return
    rts = {rt for rt in run.peak_rt or () if rt is not None}
    if len(rts) > 1:
        raise ValueError(
            f"run contains peaks at {len(rts)} retention times; select one with "
            "get_rt_slice() before plotting a spectrum"
        )


def require_rt_dimension(run):
    peak_rt = run.peak_rt
    if peak_rt is None:
        raise ValueError("run has no per-peak retention times")
    return peak_rt


def _binned_spectrum(mz, intensity, bins, mz_range):
    if bins < 1:
        raise ValueError("bins must be a positive integer")
    bins = min(bins, _MAX_SPECTRUM_BINS)

    if mz_range is None:
        maximum = max(mz, default=0.0)
        upper = maximum + maximum * 0.05
        mz_range = (
            0.0,
            upper if math.isfinite(upper) and upper > 0 else maximum or 1.0,
        )
    lower, upper = mz_range
    width = upper - lower
    if (
        not math.isfinite(lower)
        or not math.isfinite(upper)
        or width <= 0
        or not math.isfinite(width)
    ):
        raise ValueError("m/z range must be finite and increasing")

    strongest = [None] * bins
    visible_count = 0
    for index, (mass, height) in enumerate(zip(mz, intensity)):
        if mass < lower or mass > upper:
            continue
        visible_count += 1
        bin_index = min(bins - 1, math.floor(((mass - lower) / width) * bins))
        current = strongest[bin_index]
        if current is None or height > intensity[current]:
            strongest[bin_index] = index

    indices = sorted(index for index in strongest if index is not None)
    return (
        [mz[index] for index in indices],
        [intensity[index] for index in indices],
        visible_count,
        mz_range,
    )


def mass_spectrum(run, style, bins=None, mz_range=None):
    """Build a spectrum plot; optional static binning keeps one strongest peak per bin."""
    if style not in ("sticks", "profile"):
        raise ValueError(f'style must be "sticks" or "profile", got {style!r}')
    if bins is None and mz_range is not None:
        raise ValueError("mz_range requires bins")
    if bins is not None and style != "sticks":
        raise ValueError('bins is only supported for style="sticks"')
    _require_single_spectrum(run)
    so = _objects()

    mz = run.mz
    intensity = run.intensity
    if style == "profile":
        plot = so.Plot({"mz": mz, "intensity": intensity}, x="mz", y="intensity")
        return plot.add(so.Line()).label(x="m/z", y="Intensity")

    total_count = len(mz)
    if bins is not None:
        mz, intensity, visible_count, mz_range = _binned_spectrum(
            mz, intensity, bins, mz_range
        )

    # A per-row group keeps duplicate m/z values as separate sticks.
    data = {
        "mz": mz,
        "intensity": intensity,
        "baseline": [0.0] * len(mz),
        "row": list(range(len(mz))),
    }
    plot = so.Plot(data, x="mz")
    plot = plot.add(so.Range(), ymin="baseline", ymax="intensity", group="row").label(
        x="m/z", y="Intensity"
    )
    if bins is not None:
        plot = plot.limit(x=mz_range).label(
            title=f"Showing {len(mz):,} of {visible_count:,} peaks in range ({total_count:,} total)"
        )
    return plot


def rt_mz(run):
    peak_rt = require_rt_dimension(run)
    if any(rt is None for rt in peak_rt):
        raise ValueError("every peak needs a retention time for an RT/mz plot")
    so = _objects()

    data = {"rt": peak_rt, "mz": run.mz, "intensity": run.intensity}
    plot = so.Plot(data, x="rt", y="mz", color="intensity")
    return plot.add(so.Dot()).label(x="RT (s)", y="m/z", color="Intensity")


def calculate_tic(run) -> tuple[list[float], list[float]]:
    """Return sorted RTs (seconds) and summed intensities for a flat run.

    Peaks sharing an RT contribute to one point. Missing RTs raise ValueError;
    an empty run with an RT column returns two empty lists. No plotting
    dependencies are required.
    """
    peak_rt = require_rt_dimension(run)
    totals: dict[float, float] = {}
    for rt, intensity in zip(peak_rt, run.intensity, strict=True):
        if rt is None:
            raise ValueError("every peak needs a retention time for a TIC")
        totals[rt] = totals.get(rt, 0.0) + intensity
    retention_times = sorted(totals)
    intensities = [totals[time] for time in retention_times]
    if any(not math.isfinite(value) for value in intensities):
        raise OverflowError("total ion intensity exceeds the finite float range")
    return retention_times, intensities


def tic(run):
    """Build a total ion chromatogram (TIC) plot from calculated totals."""
    rt, intensity = run.calculate_tic()
    so = _objects()
    plot = so.Plot({"rt": rt, "intensity": intensity}, x="rt", y="intensity")
    return plot.add(so.Line()).label(x="RT (s)", y="Intensity")


def eic(run, mz_target, tolerance=0.0):
    """Build an extracted ion chromatogram (EIC) plot for a specific m/z value."""
    temp = run.get_mz_slice(mz_target - tolerance, mz_target + tolerance)
    so = _objects()
    data = {"rt": temp.peak_rt, "intensity": temp.intensity}
    plot = so.Plot(data, x="rt", y="intensity")
    return plot.add(so.Line()).label(x="RT (s)", y="Intensity")

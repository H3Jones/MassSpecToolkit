"""Seaborn plot builders for ``ms_py.Run``.

Embedded in the extension and loaded on the first plot call, so reading data
never imports seaborn. Builders return an unrendered ``seaborn.objects.Plot``
and pass every measurement through unchanged.
"""


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


def spectrum(run, style):
    if style not in ("sticks", "profile"):
        raise ValueError(f'style must be "sticks" or "profile", got {style!r}')
    _require_single_spectrum(run)
    so = _objects()

    mz = run.mz
    intensity = run.intensity
    if style == "profile":
        plot = so.Plot({"mz": mz, "intensity": intensity}, x="mz", y="intensity")
        return plot.add(so.Line()).label(x="m/z", y="Intensity")

    # A per-row group keeps duplicate m/z values as separate sticks.
    data = {
        "mz": mz,
        "intensity": intensity,
        "baseline": [0.0] * len(mz),
        "row": list(range(len(mz))),
    }
    plot = so.Plot(data, x="mz")
    return plot.add(so.Range(), ymin="baseline", ymax="intensity", group="row").label(
        x="m/z", y="Intensity"
    )


def rt_mz(run):
    peak_rt = run.peak_rt
    if peak_rt is None:
        raise ValueError("run has no per-peak retention times")
    if any(rt is None for rt in peak_rt):
        raise ValueError("every peak needs a retention time for an RT/mz plot")
    so = _objects()

    data = {"rt": peak_rt, "mz": run.mz, "intensity": run.intensity}
    plot = so.Plot(data, x="rt", y="mz", color="intensity")
    return plot.add(so.Dot()).label(x="RT (s)", y="m/z", color="Intensity")

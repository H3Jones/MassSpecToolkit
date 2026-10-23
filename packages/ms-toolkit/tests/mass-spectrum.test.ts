import { afterEach, describe, expect, it } from "vite-plus/test";
import { init, type EChartsType } from "echarts";
import {
  createMassSpectrumChart,
  copySpectrumPeaks,
  normalizeSpectrumPeaks,
  type MassSpectrumChartOption,
} from "../src/charts/index.ts";
import {
  MAX_RENDERED_SPECTRUM_PEAKS,
  createSpectrumSeriesData,
  createSpectrumViewportUpdate,
  selectSpectrumPeaks,
} from "../src/charts/mass-spectrum.ts";

const charts: EChartsType[] = [];
afterEach(() => {
  for (const chart of charts) chart.dispose();
  charts.length = 0;
});

function render(option: MassSpectrumChartOption, width = 640) {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width, height: 360 });
  charts.push(chart);
  chart.setOption(option);
  return chart;
}

describe("spectrum normalization", () => {
  it("normalizes to a 100% base peak without sorting or modifying input", () => {
    const peaks = Object.freeze([
      Object.freeze({ mz: 57, int: 250 }),
      Object.freeze({ mz: 43, int: 1000 }),
      Object.freeze({ mz: 57, int: 500 }),
    ]);
    expect(normalizeSpectrumPeaks(peaks)).toEqual([
      { mz: 57, int: 250, relativeIntensity: 25 },
      { mz: 43, int: 1000, relativeIntensity: 100 },
      { mz: 57, int: 500, relativeIntensity: 50 },
    ]);
    expect(peaks[0]).toEqual({ mz: 57, int: 250 });
  });

  it("handles empty data and all-zero intensities", () => {
    expect(normalizeSpectrumPeaks([])).toEqual([]);
    expect(
      normalizeSpectrumPeaks([
        { mz: 0, int: 0 },
        { mz: 43, int: 0 },
      ]),
    ).toEqual([
      { mz: 0, int: 0, relativeIntensity: 0 },
      { mz: 43, int: 0, relativeIntensity: 0 },
    ]);
  });

  it("handles very large and subnormal intensities without overflow", () => {
    expect(normalizeSpectrumPeaks([{ mz: 43, int: Number.MAX_VALUE }])[0]?.relativeIntensity).toBe(
      100,
    );
    expect(normalizeSpectrumPeaks([{ mz: 43, int: Number.MIN_VALUE }])[0]?.relativeIntensity).toBe(
      100,
    );
  });

  it.each([
    { mz: -1, int: 1 },
    { mz: NaN, int: 1 },
    { mz: Infinity, int: 1 },
    { mz: 43, int: -1 },
    { mz: 43, int: NaN },
    { mz: 43, int: Infinity },
  ])("rejects invalid peak values: %o", (peak) => {
    expect(() => normalizeSpectrumPeaks([peak])).toThrow("Peak 0");
  });

  it("rejects malformed JavaScript input rather than silently dropping peaks", () => {
    expect(() => Reflect.apply(normalizeSpectrumPeaks, null, [null])).toThrow("array");
    expect(() => Reflect.apply(normalizeSpectrumPeaks, null, [[null]])).toThrow("Peak 0");
    expect(() => Reflect.apply(normalizeSpectrumPeaks, null, [[{ mz: 43 }]])).toThrow("Peak 0");
    expect(() => Reflect.apply(normalizeSpectrumPeaks, null, [[{ mz: "43", int: 1 }]])).toThrow(
      "Peak 0",
    );
  });

  it("preserves optional assignments during copying and normalization", () => {
    const peaks = [
      { mz: 43, int: 2, label: "C2H3O+", labelHtml: "C<sub>2</sub>H<sub>3</sub>O<sup>+</sup>" },
    ];
    const copy = copySpectrumPeaks(peaks);
    expect(copy).toEqual(peaks);
    expect(copy[0]).not.toBe(peaks[0]);
    expect(normalizeSpectrumPeaks(peaks)).toEqual([{ ...peaks[0], relativeIntensity: 100 }]);
  });

  it.each([{ label: 1 }, { labelHtml: {} }])("rejects non-string annotations: %o", (annotation) => {
    expect(() =>
      Reflect.apply(copySpectrumPeaks, null, [[{ mz: 43, int: 1, ...annotation }]]),
    ).toThrow("label and labelHtml must be strings");
  });
});

describe("viewport peak selection", () => {
  const limit = MAX_RENDERED_SPECTRUM_PEAKS;

  function expectedBinnedIndices(
    peaks: readonly { mz: number; int: number }[],
    domain: readonly [number, number],
    binCount = limit,
  ) {
    const bins = new Map<number, number>();
    for (let index = 0; index < peaks.length; index++) {
      const peak = peaks[index]!;
      if (peak.mz < domain[0] || peak.mz > domain[1]) continue;
      const bin = Math.min(
        binCount - 1,
        Math.floor(((peak.mz - domain[0]) / (domain[1] - domain[0])) * binCount),
      );
      const currentIndex = bins.get(bin);
      if (currentIndex === undefined || peak.int > peaks[currentIndex]!.int) {
        bins.set(bin, index);
      }
    }
    return [...bins.values()].sort((a, b) => a - b);
  }

  it.each([0, limit - 1, limit, limit + 1])(
    "enforces the bin budget for %s visible peaks",
    (count) => {
      const peaks = Array.from({ length: count }, (_, index) => ({ mz: index, int: index }));
      const domain = [0, Math.max(1, count)] as const;
      const selection = selectSpectrumPeaks(peaks, domain);
      expect(selection.visibleCount).toBe(count);
      expect(selection.indices).toEqual(expectedBinnedIndices(peaks, domain));
      expect(selection.indices.length).toBeLessThanOrEqual(limit);
    },
  );

  it("selects the strongest peak in each bin for unsorted peaks and extreme intensities", () => {
    const peaks = Array.from({ length: limit * 3 }, (_, index) => ({
      mz: (index * 7919) % (limit * 3),
      int: index % 97 === 0 ? Number.MAX_VALUE : (index * 1543) % 137,
    }));
    const domain = [limit / 2, limit * 2] as const;
    const candidates = peaks
      .map((peak, index) => ({ ...peak, index }))
      .filter((peak) => peak.mz >= domain[0] && peak.mz <= domain[1]);
    expect(selectSpectrumPeaks(peaks, domain)).toEqual({
      indices: expectedBinnedIndices(peaks, domain),
      visibleCount: candidates.length,
    });
  });

  it("retains the first row for equal intensities in overlapping bins", () => {
    const peaks = Array.from({ length: limit + 10 }, () => ({ mz: 43, int: 0 }));
    expect(selectSpectrumPeaks(peaks, [43, 44])).toEqual({
      indices: [0],
      visibleCount: peaks.length,
    });
  });

  it("selects the strongest peak per bin, includes both boundaries, and preserves source order", () => {
    const peaks = [
      { mz: 0.1, int: 4 },
      { mz: 0.2, int: 8 },
      { mz: 1.9, int: 6 },
      { mz: 2.5, int: 3 },
      { mz: 5, int: 7 },
      { mz: 10, int: 9 },
    ];
    expect(selectSpectrumPeaks(peaks, [0, 10], 4)).toEqual({
      indices: [1, 3, 4, 5],
      visibleCount: peaks.length,
    });
    expect(selectSpectrumPeaks(peaks, [11, 12], 4)).toEqual({ indices: [], visibleCount: 0 });
  });

  it("collapses subpixel peaks to the strongest one and reveals them when zoomed", () => {
    const peaks = [
      { mz: 202.68987, int: 454_818 },
      { mz: 202.69008, int: 354_454 },
      { mz: 202.6904, int: 473_045 },
      { mz: 202.69099, int: 351_926 },
      { mz: 202.6914, int: 300_000 },
    ];
    expect(selectSpectrumPeaks(peaks, [0, 250], 783)).toEqual({
      indices: [2],
      visibleCount: peaks.length,
    });
    expect(selectSpectrumPeaks(peaks, [202.689, 202.692], 783)).toEqual({
      indices: [0, 1, 2, 3, 4],
      visibleCount: peaks.length,
    });
  });

  it("keeps the strongest overlapping peak without changing normalization or identity", () => {
    const data = normalizeSpectrumPeaks([
      ...Array.from({ length: limit }, (_, index) => ({ mz: index / limit, int: 1000 })),
      { mz: 43, int: 1, label: "weak" },
      { mz: 43, int: 2, label: "duplicate" },
    ]);
    expect(selectSpectrumPeaks(data, [0, 50]).indices).not.toContain(limit);
    const zoomed = selectSpectrumPeaks(data, [42, 44]);
    expect(zoomed).toEqual({ indices: [limit + 1], visibleCount: 2 });
    const relative = createSpectrumSeriesData(data, zoomed.indices, "relative");
    expect(relative).toMatchObject([
      { id: `peak-${limit + 1}`, sourceIndex: limit + 1, value: [43, 0.2], label: "duplicate" },
    ]);
    expect(createSpectrumSeriesData(data, [limit + 1], "relative")[0]).toEqual(relative[0]);
    expect(createSpectrumSeriesData(data, zoomed.indices, "absolute")).toMatchObject([
      { value: [43, 2], relativeIntensity: 0.2 },
    ]);
    expect(data).toHaveLength(limit + 2);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid horizontal bin counts: %s", (binCount) => {
    expect(() => selectSpectrumPeaks([], [0, 1], binCount)).toThrow("bin count");
  });

  it.each(["relative", "absolute"] as const)(
    "preserves native zoom geometry and %s scaling during viewport series updates",
    (intensityMode) => {
      const data = normalizeSpectrumPeaks([
        ...Array.from({ length: limit }, (_, index) => ({ mz: index / limit, int: 1000 })),
        { mz: 43, int: 1 },
        { mz: 44, int: 2 },
      ]);
      const chart = render(createMassSpectrumChart(data, { intensityMode }));
      const top = chart.convertFromPixel({ yAxisIndex: 0 }, 45);
      for (const domain of [
        [42, 45],
        [20, 30],
        [0, 46.2],
      ] as const) {
        chart.dispatchAction({
          type: "dataZoom",
          dataZoomId: "mz-inside",
          startValue: domain[0],
          endValue: domain[1],
        });
        const coordinates = domain.map((value) => chart.convertToPixel({ xAxisIndex: 0 }, value));
        const selection = selectSpectrumPeaks(data, domain);
        chart.setOption(
          createSpectrumViewportUpdate(data, selection.indices, intensityMode, domain),
        );
        expect(domain.map((value) => chart.convertToPixel({ xAxisIndex: 0 }, value))).toEqual(
          coordinates,
        );
        expect(chart.convertFromPixel({ yAxisIndex: 0 }, 45)).toBe(top);
        expect(chart.getOption().dataZoom).toMatchObject([
          { startValue: domain[0], endValue: domain[1] },
          { startValue: domain[0], endValue: domain[1] },
          { id: "intensity-inside" },
          { id: "intensity-slider" },
        ]);
      }
    },
  );
});

describe("mass spectrum chart", () => {
  const peaks = [
    { mz: 43, int: 1000 },
    { mz: 57, int: 250 },
  ];

  it("draws independent vertical sticks starting exactly at zero", () => {
    const option = createMassSpectrumChart(peaks, { color: "#2563eb" });
    const chart = render(option);
    const svg = chart.renderToSVGString();
    const sticks = [
      ...svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*stroke="#2563eb"/g),
    ];
    expect(sticks).toHaveLength(2);
    for (const [index, stick] of sticks.entries()) {
      expect(stick[1]).toBe(stick[3]);
      expect(Number(stick[2])).toBeCloseTo(chart.convertToPixel({ yAxisIndex: 0 }, 0), 1);
      expect(Number(stick[4])).toBeCloseTo(
        chart.convertToPixel({ yAxisIndex: 0 }, index === 0 ? 100 : 25),
        1,
      );
    }
    expect(option.xAxis).toMatchObject({ min: 0, max: 59.85 });
    expect(option.yAxis).toMatchObject({ min: 0, max: 110 });
    expect(option.series).toMatchObject([
      {
        data: [
          { value: [43, 100], mz: 43, int: 1000, relativeIntensity: 100 },
          { value: [57, 25], mz: 57, int: 250, relativeIntensity: 25 },
        ],
      },
    ]);
  });

  it("supports color and optional peak labels", () => {
    const svg = render(
      createMassSpectrumChart(peaks, { color: "#2563eb", labels: false }),
    ).renderToSVGString();
    expect(svg).toContain('stroke="#2563eb"');
    expect(svg).not.toContain(">43</text>");
    expect(render(createMassSpectrumChart(peaks)).renderToSVGString()).toContain(">43</text>");
  });

  it("plots absolute intensities in their original units without changing measurements", () => {
    const input = Object.freeze([
      Object.freeze({ mz: 57, int: 250 }),
      Object.freeze({ mz: 43, int: 1000 }),
      Object.freeze({ mz: 57, int: 500 }),
    ]);
    const option = createMassSpectrumChart(input, {
      intensityMode: "absolute",
      color: "#2563eb",
    });
    expect(option.yAxis).toMatchObject({
      min: 0,
      max: undefined,
      boundaryGap: [0, "10%"],
      name: "Absolute intensity",
    });
    expect(option.series).toMatchObject([
      {
        dimensions: ["mz", "int"],
        data: [
          { value: [43, 1000], mz: 43, int: 1000, relativeIntensity: 100 },
          { value: [57, 500], mz: 57, int: 500, relativeIntensity: 50 },
        ],
      },
      {
        id: "intensity-extent",
        data: [
          [0, 250],
          [0, 1000],
        ],
      },
    ]);
    const chart = render(option);
    const svg = chart.renderToSVGString();
    expect(svg).toContain("Absolute intensity");
    const sticks = [
      ...svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*stroke="#2563eb"/g),
    ];
    expect(sticks).toHaveLength(2);
    const visiblePeaks = [input[1]!, input[2]!];
    for (const [index, stick] of sticks.entries()) {
      expect(Number(stick[2])).toBeCloseTo(chart.convertToPixel({ yAxisIndex: 0 }, 0), 1);
      expect(Number(stick[4])).toBe(
        Number(chart.convertToPixel({ yAxisIndex: 0 }, visiblePeaks[index]!.int).toFixed(1)),
      );
    }
    expect(input[0]).toEqual({ mz: 57, int: 250 });
  });

  it("uses ECharts nice ticks instead of a fixed padded absolute maximum", () => {
    const chart = render(
      createMassSpectrumChart(
        [
          { mz: 202.85354, int: 917_992 },
          { mz: 204.55546, int: 1_842_229 },
        ],
        { intensityMode: "absolute" },
      ),
    );
    expect(chart.convertFromPixel({ yAxisIndex: 0 }, 45)).toBe(2_100_000);
    const svg = chart.renderToSVGString();
    for (const tick of [
      "300,000",
      "600,000",
      "900,000",
      "1,200,000",
      "1,500,000",
      "1,800,000",
      "2,100,000",
    ]) {
      expect(svg).toContain(`>${tick}</text>`);
    }
    expect(chart.getOption().series).toMatchObject([
      { data: [{ value: [202.85354, 917_992] }, { value: [204.55546, 1_842_229] }] },
      {
        id: "intensity-extent",
        data: [
          [0, 917_992],
          [0, 1_842_229],
        ],
      },
    ]);
  });

  it.each([0, 1e-8, 1e-19, 1e-20, 1e-300, 2 ** -1022, Number.MIN_VALUE, 1e308, Number.MAX_VALUE])(
    "keeps the absolute intensity axis and geometry finite for %s",
    (intensity) => {
      const option = createMassSpectrumChart([{ mz: 43, int: intensity }], {
        intensityMode: "absolute",
      });
      expect(option.yAxis).toMatchObject({ min: 0, name: "Absolute intensity" });
      const chart = render(option);
      const svg = chart.renderToSVGString();
      expect(svg).not.toMatch(/NaN|Infinity/);
      expect(chart.convertToPixel({ yAxisIndex: 0 }, intensity)).toBeGreaterThanOrEqual(0);
      if (intensity > 0) {
        expect(chart.convertToPixel({ yAxisIndex: 0 }, intensity)).toBeLessThan(
          chart.convertToPixel({ yAxisIndex: 0 }, 0),
        );
      }
    },
  );

  it("handles an empty absolute spectrum with a nonzero axis range", () => {
    const option = createMassSpectrumChart([], { intensityMode: "absolute" });
    expect(option.yAxis).toMatchObject({ min: 0, max: 1 });
    expect(render(option).renderToSVGString()).not.toMatch(/NaN|Infinity/);
  });

  it("preserves an explicit m/z zoom while changing the intensity scale", () => {
    const chart = render(createMassSpectrumChart(peaks, { zoomDomain: [50, 58] }));
    chart.setOption(
      createMassSpectrumChart(peaks, { intensityMode: "absolute", zoomDomain: [50, 58] }),
      { notMerge: true },
    );
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 50, endValue: 58 },
      { startValue: 50, endValue: 58 },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
    expect(chart.getOption().series).toMatchObject([
      { data: [{ value: [57, 250] }] },
      {
        id: "intensity-extent",
        data: [
          [0, 250],
          [0, 1000],
        ],
      },
    ]);
    chart.setOption(createMassSpectrumChart(peaks, { zoomDomain: [50, 58] }), { notMerge: true });
    expect(chart.getOption().series).toMatchObject([{ data: [{ value: [57, 25] }] }]);
  });

  it.each(["", "counts", null, 1])("rejects unsupported intensity modes: %j", (intensityMode) => {
    expect(() => Reflect.apply(createMassSpectrumChart, null, [peaks, { intensityMode }])).toThrow(
      'intensity mode must be "relative" or "absolute"',
    );
  });

  it("supports readable axis labels and controls on dark backgrounds", () => {
    const option = createMassSpectrumChart(peaks, { textColor: "#f1f5f9" });
    expect(option.xAxis).toMatchObject({
      nameTextStyle: { color: "#f1f5f9" },
      axisLabel: { color: "#f1f5f9" },
    });
    expect(option.yAxis).toMatchObject({ axisLabel: { color: "#f1f5f9" } });
    expect(option.toolbox).toMatchObject({
      iconStyle: { borderColor: "#f1f5f9" },
      emphasis: { iconStyle: { borderColor: "#f1f5f9" } },
    });
    expect(render(option).renderToSVGString()).toContain('fill="#f1f5f9"');
  });

  it("enables native inside and slider zoom without filtering or renormalizing peaks", () => {
    expect(createMassSpectrumChart(peaks).dataZoom).toMatchObject([
      {
        type: "inside",
        xAxisIndex: 0,
        filterMode: "none",
      },
      { type: "slider", xAxisIndex: 0, filterMode: "none", showDataShadow: false },
      {
        id: "intensity-inside",
        type: "inside",
        yAxisIndex: 0,
        filterMode: "none",
        zoomOnMouseWheel: "shift",
      },
      {
        id: "intensity-slider",
        type: "slider",
        yAxisIndex: 0,
        filterMode: "none",
        orient: "vertical",
        showDataShadow: false,
      },
    ]);
    const chart = render(createMassSpectrumChart(peaks));
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "mz-inside",
      startValue: 50,
      endValue: 58,
    });
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 50, endValue: 58 },
      { startValue: 50, endValue: 58 },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
    expect(chart.getOption().series).toMatchObject([
      { data: [{ value: [43, 100] }, { value: [57, 25] }] },
    ]);
  });

  it("zooms intensity independently and preserves that range on m/z viewport updates", () => {
    const data = normalizeSpectrumPeaks(peaks);
    const chart = render(createMassSpectrumChart(data));
    const mzPixel = chart.convertToPixel({ xAxisIndex: 0 }, 57);
    const intensityPixel = chart.convertToPixel({ yAxisIndex: 0 }, 25);
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "intensity-inside",
      startValue: 0,
      endValue: 50,
    });
    expect(chart.convertToPixel({ xAxisIndex: 0 }, 57)).toBe(mzPixel);
    expect(chart.convertToPixel({ yAxisIndex: 0 }, 25)).not.toBe(intensityPixel);
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 0, endValue: 59.85 },
      { startValue: 0, endValue: 59.85 },
      { id: "intensity-inside", startValue: 0, endValue: 50 },
      { id: "intensity-slider", startValue: 0, endValue: 50 },
    ]);

    const selection = selectSpectrumPeaks(data, [0, 105]);
    chart.setOption(createSpectrumViewportUpdate(data, selection.indices, "relative", [0, 105]));
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 0, endValue: 59.85 },
      { startValue: 0, endValue: 59.85 },
      { id: "intensity-inside", startValue: 0, endValue: 50 },
      { id: "intensity-slider", startValue: 0, endValue: 50 },
    ]);
  });

  it("fully restores both axes after zooming them independently", () => {
    const chart = render(createMassSpectrumChart(peaks));
    const initialMzPixel = chart.convertToPixel({ xAxisIndex: 0 }, 57);
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "mz-inside",
      startValue: 50,
      endValue: 58,
    });
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "intensity-inside",
      startValue: 0,
      endValue: 50,
    });
    expect(chart.convertToPixel({ xAxisIndex: 0 }, 57)).not.toBe(initialMzPixel);

    chart.dispatchAction({ type: "restore" });
    expect(chart.convertToPixel({ xAxisIndex: 0 }, 57)).toBe(initialMzPixel);
    expect(chart.getOption().dataZoom).toMatchObject([
      { id: "mz-inside", startValue: 0, endValue: 59.85 },
      { id: "mz-slider", startValue: 0, endValue: 59.85 },
      { id: "intensity-inside", startValue: 0, endValue: 110 },
      { id: "intensity-slider", startValue: 0, endValue: 110 },
    ]);
  });

  it("uses native axis hover and default tooltip positioning", () => {
    const option = createMassSpectrumChart(peaks);
    expect(option.tooltip).toMatchObject({ trigger: "axis", confine: true });
    expect(option.tooltip).not.toHaveProperty("position");
    expect(option.tooltip).not.toHaveProperty("renderMode");
    const chart = render(option);
    expect(chart.getOption().dataZoom).toMatchObject([
      { type: "inside", zoomOnMouseWheel: true, moveOnMouseMove: true },
      { type: "slider" },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
  });

  it("keeps a dark, outlined pointer visible during hover and panning", () => {
    const option = createMassSpectrumChart(peaks);
    const zoom = Array.isArray(option.dataZoom) ? option.dataZoom[0] : option.dataZoom;
    if (!zoom || zoom.type !== "inside") throw new Error("Missing inside zoom");
    const cursor = zoom.cursorGrab;
    expect(cursor).toBe(zoom.cursorGrabbing);
    expect(cursor).toMatch(/^url\("data:image\/svg\+xml,/);
    const svg = decodeURIComponent(cursor!.split(",")[1]!.split('"')[0]!);
    expect(svg).toContain('fill="#111827"');
    expect(svg).toContain('stroke="#fff"');
    expect(cursor).toMatch(/\) 3 2, default$/);
    expect(render(option).getOption().dataZoom).toMatchObject([
      { cursorGrab: cursor, cursorGrabbing: cursor },
      { type: "slider" },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
  });

  it("places native area zoom and undo on the right for both axes", () => {
    const option = createMassSpectrumChart(peaks);
    expect(option.toolbox).toMatchObject({
      right: 25,
      feature: { dataZoom: { xAxisIndex: 0, yAxisIndex: 0, filterMode: "none" } },
    });
    expect(option.toolbox).toHaveProperty("feature.restore");
    expect(option.toolbox).not.toHaveProperty("left");
    const chart = render(option);
    chart.dispatchAction({
      type: "takeGlobalCursor",
      key: "dataZoomSelect",
      dataZoomSelectActive: true,
    });
    expect(chart.getOption().yAxis).toMatchObject([{ min: 0, max: 110 }]);
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
  });

  it.each([{ peaks: [] }, { peaks: [{ mz: 0, int: 0 }] }, { peaks: [{ mz: 43, int: 0 }] }])(
    "produces finite geometry for empty or zero-valued data: %o",
    ({ peaks }) => {
      const chart = render(createMassSpectrumChart(peaks), 320);
      const svg = chart.renderToSVGString();
      expect(svg).not.toMatch(/NaN|Infinity/);
      expect(chart.convertToPixel({ xAxisIndex: 0 }, 0)).toBeGreaterThanOrEqual(0);
    },
  );

  it("scales stick geometry to the available width", () => {
    const chart = createMassSpectrumChart(peaks);
    const narrow = render(chart, 320);
    const wide = render(chart, 800);
    expect(wide.convertToPixel({ xAxisIndex: 0 }, 57)).toBeGreaterThan(
      narrow.convertToPixel({ xAxisIndex: 0 }, 57),
    );
  });

  it("renders axis labels, precise peak labels and accessible SVG", () => {
    const chart = createMassSpectrumChart([{ mz: 43.123456, int: 1 }]);
    const svg = render(chart).renderToSVGString();
    expect(chart.aria).toMatchObject({ enabled: true });
    expect(svg).toContain("m/z");
    expect(svg).toContain("Relative intensity (%)");
    expect(svg).toContain("43.1235");
  });

  it("rejects an unrepresentable m/z display range", () => {
    expect(() => createMassSpectrumChart([{ mz: Number.MAX_VALUE, int: 1 }])).toThrow("range");
  });

  it("supports a focused m/z viewport without renormalizing its peaks", () => {
    const chart = createMassSpectrumChart(peaks, { mzDomain: [50, 60] });
    expect(chart.xAxis).toMatchObject({ min: 50, max: 60 });
    expect(render(chart).getOption().series).toMatchObject([{ data: [{ value: [57, 25] }] }]);
  });

  it("renders at most the peak budget and keeps the complete m/z extent", () => {
    const count = MAX_RENDERED_SPECTRUM_PEAKS + 50;
    const peaks = Array.from({ length: count }, (_, index) => ({ mz: index, int: index + 1 }));
    const option = createMassSpectrumChart(peaks, { labels: false, color: "#2563eb" });
    expect(option.xAxis).toMatchObject({ min: 0, max: (count - 1) * 1.05 });
    const svg = render(option).renderToSVGString();
    const sticks = [
      ...svg.matchAll(/<path d="M[\d.-]+ [\d.-]+L[\d.-]+ [\d.-]+"[^>]*stroke="#2563eb"/g),
    ];
    expect(sticks).toHaveLength(selectSpectrumPeaks(peaks, [0, (count - 1) * 1.05]).indices.length);
    expect(sticks.length).toBeLessThanOrEqual(MAX_RENDERED_SPECTRUM_PEAKS);
    expect(peaks).toHaveLength(count);
  });

  it.each([
    [50, 58],
    [30, 40],
  ])(
    "keeps the full-dataset absolute scale in a weak or empty viewport [%s, %s]",
    (minimum, maximum) => {
      const option = createMassSpectrumChart(
        [
          { mz: 43, int: 1_842_229 },
          { mz: 57, int: 917_992 },
        ],
        { intensityMode: "absolute", zoomDomain: [minimum, maximum] },
      );
      const chart = render(option);
      expect(chart.convertFromPixel({ yAxisIndex: 0 }, 45)).toBe(2_100_000);
      expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    },
  );

  it("supports a zoomed viewport within the default m/z range", () => {
    const chart = createMassSpectrumChart(peaks, {
      zoomDomain: [50, 55],
    });
    expect(render(chart).getOption().dataZoom).toMatchObject([
      { startValue: 50, endValue: 55 },
      { startValue: 50, endValue: 55 },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
  });

  it("preserves fine-structure zoom precision and restores the complete explicit extent", () => {
    const chart = render(
      createMassSpectrumChart(
        [
          { mz: 46.041864812949996, int: 1 },
          { mz: 47.045219648019994, int: 0.01 },
        ],
        { mzDomain: [45.5, 56.5] },
      ),
    );
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "mz-inside",
      startValue: 46.04184,
      endValue: 46.04188,
    });
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 46.04184, endValue: 46.04188 },
      { startValue: 46.04184, endValue: 46.04188 },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "mz-inside",
      startValue: 45.5,
      endValue: 56.5,
    });
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 45.5, endValue: 56.5 },
      { startValue: 45.5, endValue: 56.5 },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
  });

  it("clamps floating-point drift at the m/z range boundaries", () => {
    const domain = [45.5, 56.5] as const;
    const tolerance = Number.EPSILON * domain[1] * 8;
    const chart = createMassSpectrumChart(peaks, {
      mzDomain: domain,
      zoomDomain: [domain[0] - tolerance, domain[1] + tolerance],
    });
    expect(render(chart).getOption().dataZoom).toMatchObject([
      { startValue: domain[0], endValue: domain[1] },
      { startValue: domain[0], endValue: domain[1] },
      { id: "intensity-inside" },
      { id: "intensity-slider" },
    ]);
  });

  it("rejects a zoom window outside the default m/z range", () => {
    expect(() =>
      createMassSpectrumChart(peaks, {
        mzDomain: [50, 60],
        zoomDomain: [45, 55],
      }),
    ).toThrow("zoom range");
  });

  it.each([
    [50, 50],
    [60, 50],
    [-1, 50],
    [NaN, 50],
    [0, Infinity],
  ])("rejects invalid m/z domain [%s, %s]", (minimum, maximum) => {
    expect(() => createMassSpectrumChart(peaks, { mzDomain: [minimum, maximum] })).toThrow("range");
  });

  it("keeps assignments in tooltips without replacing the m/z labels", () => {
    const peak = { mz: 43, int: 1, labelHtml: "C<sub>2</sub>H<sub>3</sub>O<sup>+</sup>" };
    const chart = render(createMassSpectrumChart([peak]));
    expect(chart.getOption().series).toMatchObject([{ data: [{ labelHtml: peak.labelHtml }] }]);
    expect(chart.renderToSVGString()).toContain(">43</text>");
  });

  it("renders the strongest duplicate m/z and preserves very small positive intensities", () => {
    const peaks = [
      { mz: 46.04131623304093, int: 1 },
      { mz: 47.04467106811093, int: 1e-12 },
      { mz: 47.04467106811093, int: 0.5 },
    ];
    const chart = render(createMassSpectrumChart(peaks));
    expect(chart.getOption().series).toMatchObject([
      {
        data: [
          { value: [peaks[0]!.mz, 100], tooltip: { trigger: "item" } },
          { value: [peaks[2]!.mz, 50], tooltip: { trigger: "item" } },
        ],
      },
    ]);
  });
});

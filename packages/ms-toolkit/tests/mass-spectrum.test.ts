import { afterEach, describe, expect, it } from "vite-plus/test";
import { init, type EChartsType } from "echarts";
import {
  createMassSpectrumChart,
  copySpectrumPeaks,
  normalizeSpectrumPeaks,
  type MassSpectrumChartOption,
} from "../src/charts/index.ts";

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
          { value: [57, 250], mz: 57, int: 250, relativeIntensity: 25 },
          { value: [43, 1000], mz: 43, int: 1000, relativeIntensity: 100 },
          { value: [57, 500], mz: 57, int: 500, relativeIntensity: 50 },
        ],
      },
    ]);
    const chart = render(option);
    const svg = chart.renderToSVGString();
    expect(svg).toContain("Absolute intensity");
    const sticks = [
      ...svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"[^>]*stroke="#2563eb"/g),
    ];
    expect(sticks).toHaveLength(3);
    for (const [index, stick] of sticks.entries()) {
      expect(Number(stick[2])).toBeCloseTo(chart.convertToPixel({ yAxisIndex: 0 }, 0), 1);
      expect(Number(stick[4])).toBe(
        Number(chart.convertToPixel({ yAxisIndex: 0 }, input[index]!.int).toFixed(1)),
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
    ]);
    expect(chart.getOption().series).toMatchObject([
      { data: [{ value: [43, 1000] }, { value: [57, 250] }] },
    ]);
    chart.setOption(createMassSpectrumChart(peaks, { zoomDomain: [50, 58] }), { notMerge: true });
    expect(chart.getOption().series).toMatchObject([
      { data: [{ value: [43, 100] }, { value: [57, 25] }] },
    ]);
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
    expect(option.toolbox).toMatchObject({ iconStyle: { borderColor: "#f1f5f9" } });
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
    ]);
    const chart = render(createMassSpectrumChart(peaks));
    chart.dispatchAction({ type: "dataZoom", startValue: 50, endValue: 58 });
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 50, endValue: 58 },
      { startValue: 50, endValue: 58 },
    ]);
    expect(chart.getOption().series).toMatchObject([
      { data: [{ value: [43, 100] }, { value: [57, 25] }] },
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
    ]);
  });

  it("provides native area zoom and undo restricted to the m/z axis", () => {
    const option = createMassSpectrumChart(peaks);
    expect(option.toolbox).toMatchObject({
      left: 75,
      feature: { dataZoom: { xAxisIndex: 0, yAxisIndex: "none", filterMode: "none" } },
    });
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
    expect(render(chart).getOption().series).toMatchObject([
      { data: [{ value: [43, 100] }, { value: [57, 25] }] },
    ]);
  });

  it("supports a zoomed viewport within the default m/z range", () => {
    const chart = createMassSpectrumChart(peaks, {
      zoomDomain: [50, 55],
    });
    expect(render(chart).getOption().dataZoom).toMatchObject([
      { startValue: 50, endValue: 55 },
      { startValue: 50, endValue: 55 },
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
    chart.dispatchAction({ type: "dataZoom", startValue: 46.04184, endValue: 46.04188 });
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 46.04184, endValue: 46.04188 },
      { startValue: 46.04184, endValue: 46.04188 },
    ]);
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    chart.dispatchAction({ type: "dataZoom", startValue: 45.5, endValue: 56.5 });
    expect(chart.getOption().dataZoom).toMatchObject([
      { startValue: 45.5, endValue: 56.5 },
      { startValue: 45.5, endValue: 56.5 },
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

  it("preserves duplicate m/z rows and very small positive relative intensities", () => {
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
          { value: [peaks[1]!.mz, 1e-10], tooltip: { trigger: "item" } },
          { value: [peaks[2]!.mz, 50], tooltip: { trigger: "item" } },
        ],
      },
    ]);
  });
});

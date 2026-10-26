import { afterEach, describe, expect, it } from "vite-plus/test";
import { init, type EChartsType } from "echarts";
import { createTicChart, findNearestTicPointIndex, ticBinCount } from "../src/charts/tic.ts";

const charts: EChartsType[] = [];
afterEach(() => {
  for (const chart of charts) chart.dispose();
  charts.length = 0;
});

function render(
  points = [
    { retentionTime: 0, intensity: 0 },
    { retentionTime: 2, intensity: 150 },
  ],
) {
  const chart = init(null, undefined, { renderer: "svg", ssr: true, width: 640, height: 280 });
  charts.push(chart);
  chart.setOption(createTicChart(points, [0, 2], [2, 2]));
  return chart;
}

describe("TIC chart", () => {
  it.each([
    [0, 0],
    [0.25, 0],
    [0.5, 0],
    [0.75, 1],
    [1, 1],
    [2.5, 1],
    [3.75, 2],
    [4, 2],
  ])("snaps RT %s to displayed point %s, independent of intensity", (retentionTime, index) => {
    const points = Object.freeze([
      Object.freeze({ retentionTime: 0, intensity: 0 }),
      Object.freeze({ retentionTime: 1, intensity: 1e9 }),
      Object.freeze({ retentionTime: 4, intensity: 10 }),
    ]);
    expect(findNearestTicPointIndex(points, retentionTime, [0, 4])).toBe(index);
  });

  it("only snaps to points inside the current RT viewport", () => {
    const points = [
      { retentionTime: 0, intensity: 10 },
      { retentionTime: 2, intensity: 20 },
      { retentionTime: 4, intensity: 30 },
    ];
    expect(findNearestTicPointIndex(points, 0.5, [0.5, 3.5])).toBe(1);
    expect(findNearestTicPointIndex(points, 3.5, [0.5, 3.5])).toBe(1);
    expect(findNearestTicPointIndex(points, 1, [0.5, 1.5])).toBe(-1);
    expect(findNearestTicPointIndex([], 1, [0, 4])).toBe(-1);
    expect(findNearestTicPointIndex([points[0]], 0.25, [0, 0])).toBe(0);
  });

  it("rejects non-finite click coordinates and invalid RT viewports", () => {
    for (const rt of [NaN, Infinity, -Infinity]) {
      expect(() => findNearestTicPointIndex([], rt, [0, 1])).toThrow("TIC click RT");
    }
    expect(() => findNearestTicPointIndex([], 0, [1, 0])).toThrow("TIC RT bounds");
  });

  it.each([
    [109685260.796875, "1.097e+8"],
    [150, "1.500e+2"],
    [0.00001234, "1.234e-5"],
    [0, "0.000e+0"],
  ])("formats tooltip intensity %s as %s without changing the data", (intensity, expected) => {
    const option = createTicChart([{ retentionTime: 1.25, intensity }], [0, 2]);
    const tooltip = option.tooltip;
    if (!tooltip || Array.isArray(tooltip) || typeof tooltip.valueFormatter !== "function") {
      throw new Error("The TIC must provide a tooltip value formatter.");
    }
    expect(tooltip.valueFormatter(intensity, 0)).toBe(expected);
    expect(option.series).toMatchObject([
      {
        encode: { x: 0, y: 1, tooltip: [1] },
        data: [[1.25, intensity]],
      },
    ]);
  });

  it("plots original scan totals with RT and intensity axes, including zero", () => {
    const chart = render();
    expect(chart.getOption().series).toMatchObject([
      {
        type: "line",
        data: [
          [0, 0],
          [2, 150],
        ],
      },
    ]);
    expect(chart.getOption().xAxis).toMatchObject([{ name: "RT (input units)", min: 0, max: 2 }]);
    expect(chart.getOption().yAxis).toMatchObject([{ name: "Total ion intensity", min: 0 }]);
    expect(chart.renderToSVGString()).toContain("<svg");
  });

  it("highlights a selected RT or inclusive interval without changing scan totals", () => {
    const chart = render();
    expect(chart.getOption().series).toMatchObject([{ markLine: { data: [{ xAxis: 2 }] } }]);
    const update = createTicChart([{ retentionTime: 0, intensity: 150 }], [0, 2], [0, 2]);
    chart.setOption({ series: update.series });
    expect(chart.getOption().series).toMatchObject([
      {
        data: [[0, 150]],
        markLine: { data: [] },
        markArea: { data: [[{ xAxis: 0 }, { xAxis: 2 }]] },
      },
    ]);
  });

  it("keeps zoom interactive with no data and preserves it across series/selection updates", () => {
    const chart = render([]);
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "rt-inside",
      startValue: 0.5,
      endValue: 1.5,
    });
    const update = createTicChart([{ retentionTime: 1, intensity: 20 }], [0, 2], [1, 1]);
    chart.setOption({ series: update.series });
    expect(chart.getOption().dataZoom).toMatchObject([{ startValue: 0.5, endValue: 1.5 }, {}]);
    chart.dispatchAction({ type: "restore" });
    expect(chart.getOption().dataZoom).toMatchObject([{ startValue: 0, endValue: 2 }, {}]);
  });

  it("disables tooltips for empty viewports and restores them when scan totals return", () => {
    const chart = render();
    expect(chart.getOption().tooltip).toMatchObject([{ show: true }]);
    const empty = createTicChart([], [0, 2]);
    chart.setOption({ series: empty.series, tooltip: empty.tooltip });
    expect(chart.getOption().tooltip).toMatchObject([{ show: false }]);
    const loaded = createTicChart([{ retentionTime: 1, intensity: 100 }], [0, 2]);
    chart.setOption({ series: loaded.series, tooltip: loaded.tooltip });
    expect(chart.getOption().tooltip).toMatchObject([{ show: true }]);
  });

  it("gives single RT zero a nonzero axis span", () => {
    const option = createTicChart([{ retentionTime: 0, intensity: 0 }], [0, 0], [0, 0]);
    expect(option.xAxis).toMatchObject({ min: 0, max: 0.5 });
  });

  it("applies theme text colors without resetting the RT viewport", () => {
    const chart = render();
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomId: "rt-inside",
      startValue: 0.5,
      endValue: 1.5,
    });
    const option = createTicChart([{ retentionTime: 1, intensity: 50 }], [0, 2], [1, 1], {
      color: "#7da7ff",
      textColor: "#f1f5f9",
    });
    chart.setOption({
      series: option.series,
      textStyle: option.textStyle,
      xAxis: option.xAxis,
      yAxis: option.yAxis,
    });
    expect(chart.getOption().dataZoom).toMatchObject([{ startValue: 0.5, endValue: 1.5 }, {}]);
    expect(chart.getOption().xAxis).toMatchObject([{ axisLabel: { color: "#f1f5f9" } }]);
    expect(chart.getOption().yAxis).toMatchObject([{ nameTextStyle: { color: "#f1f5f9" } }]);
  });

  it("validates ranges, bin budgets, ordering and non-finite totals", () => {
    expect(ticBinCount({ rtRange: [0, 0], binCount: 5000 })).toBe(1000);
    expect(() => ticBinCount({ rtRange: [1, 0], binCount: 1 })).toThrow("RT bounds");
    expect(() => ticBinCount({ rtRange: [0, 1], binCount: 0 })).toThrow("bin count");
    for (const intensity of [NaN, Infinity, -1]) {
      expect(() => createTicChart([{ retentionTime: 0, intensity }], [0, 1])).toThrow("TIC points");
    }
    expect(() => createTicChart([{ retentionTime: 2, intensity: 1 }], [0, 1])).toThrow(
      "TIC points",
    );
    expect(() =>
      createTicChart(
        [
          { retentionTime: 1, intensity: 1 },
          { retentionTime: 0, intensity: 1 },
        ],
        [0, 1],
      ),
    ).toThrow("TIC points");
  });
});

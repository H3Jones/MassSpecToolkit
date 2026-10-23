import { afterEach, describe, expect, it } from "vite-plus/test";
import { init, type EChartsType } from "echarts";
import { createTicChart, ticBinCount } from "../src/charts/tic.ts";

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

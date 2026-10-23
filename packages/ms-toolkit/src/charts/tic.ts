import type { EChartsOption } from "echarts";

export const MAX_RENDERED_TIC_POINTS = 1000;

export interface TicPoint {
  readonly retentionTime: number;
  readonly intensity: number;
}

export interface TicViewportRequest {
  readonly rtRange: readonly [number, number];
  readonly binCount: number;
}

export interface TicViewportResult {
  readonly points: readonly TicPoint[];
  readonly visibleCount: number;
}

export interface TicViewportSource {
  readonly rtRange: readonly [number, number];
  query(request: TicViewportRequest): Promise<TicViewportResult>;
}

/** One complete scan total per bin, not a sum of neighboring scan totals. */
export function ticBinCount(request: TicViewportRequest): number {
  const [minimum, maximum] = request.rtRange;
  if (
    request.rtRange.length !== 2 ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum < 0 ||
    maximum < minimum
  ) {
    throw new RangeError("TIC RT bounds must be finite, nonnegative, and increasing or equal.");
  }
  if (!Number.isSafeInteger(request.binCount) || request.binCount < 1) {
    throw new RangeError("TIC bin count must be a positive integer.");
  }
  return Math.min(request.binCount, MAX_RENDERED_TIC_POINTS);
}

export function createTicChart(
  points: readonly TicPoint[],
  rtRange: readonly [number, number],
  selectedRange?: readonly [number, number],
  options: { readonly color?: string; readonly textColor?: string } = {},
): EChartsOption {
  const { color = "#2563eb", textColor = "#475569" } = options;
  ticBinCount({ rtRange, binCount: 1 });
  if (selectedRange) ticBinCount({ rtRange: selectedRange, binCount: 1 });
  let previous = -1;
  for (const point of points) {
    if (
      !Number.isFinite(point.retentionTime) ||
      point.retentionTime < rtRange[0] ||
      point.retentionTime > rtRange[1] ||
      point.retentionTime <= previous ||
      !Number.isFinite(point.intensity) ||
      point.intensity < 0
    ) {
      throw new TypeError(
        "TIC points must have increasing RT and finite, nonnegative intensities.",
      );
    }
    previous = point.retentionTime;
  }
  // A single scan (including RT zero) needs a nonzero plotting domain.
  const padding = Math.max(rtRange[0] * 0.01, 0.5);
  const domain =
    rtRange[0] === rtRange[1]
      ? [Math.max(0, rtRange[0] - padding), Math.min(Number.MAX_VALUE, rtRange[1] + padding)]
      : rtRange;
  return {
    animation: false,
    textStyle: { color: textColor },
    aria: {
      enabled: true,
      label: { description: "Total ion chromatogram. Original intensity summed at each RT." },
    },
    grid: { left: 90, right: 25, top: 35, bottom: 85 },
    xAxis: {
      type: "value",
      name: "RT (input units)",
      nameLocation: "middle",
      nameGap: 28,
      min: domain[0],
      max: domain[1],
      nameTextStyle: { color: textColor },
      axisLabel: { color: textColor },
      splitLine: { lineStyle: { color: textColor, opacity: 0.15 } },
    },
    yAxis: {
      type: "value",
      name: "Total ion intensity",
      min: 0,
      nameTextStyle: { color: textColor },
      axisLabel: {
        color: textColor,
        formatter: (value: number) => (value === 0 ? "0" : value.toExponential(1)),
      },
      splitLine: { lineStyle: { color: textColor, opacity: 0.15 } },
    },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      valueFormatter: (value) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new TypeError("TIC tooltip intensity must be a finite number.");
        }
        return value.toExponential(3);
      },
    },
    dataZoom: [
      { id: "rt-inside", type: "inside", xAxisIndex: 0, filterMode: "none" },
      {
        id: "rt-slider",
        type: "slider",
        xAxisIndex: 0,
        bottom: 8,
        filterMode: "none",
        showDataShadow: false,
      },
    ],
    toolbox: { feature: { restore: { title: "Restore RT range" } } },
    series: [
      {
        id: "tic",
        type: "line",
        name: "TIC",
        showSymbol: true,
        symbol: "circle",
        symbolSize: 7,
        lineStyle: { width: 1.5 },
        itemStyle: { color },
        encode: { x: 0, y: 1, tooltip: [1] },
        data: points.map((point) => [point.retentionTime, point.intensity]),
        markLine: {
          silent: true,
          symbol: "none",
          label: { show: false },
          lineStyle: { color },
          data:
            selectedRange && selectedRange[0] === selectedRange[1]
              ? [{ xAxis: selectedRange[0] }]
              : [],
        },
        markArea: {
          silent: true,
          itemStyle: { color, opacity: 0.12 },
          data:
            selectedRange && selectedRange[0] !== selectedRange[1]
              ? [[{ xAxis: selectedRange[0] }, { xAxis: selectedRange[1] }]]
              : [],
        },
      },
    ],
  };
}

import type { ComposeOption } from "echarts/core";
import type { CustomSeriesOption } from "echarts/charts";
import type {
  AriaComponentOption,
  DataZoomComponentOption,
  GridComponentOption,
  ToolboxComponentOption,
  TooltipComponentOption,
} from "echarts/components";
import { createSpectrumTooltip } from "./spectrum-tooltip.ts";

const plotCursor = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="26" viewBox="0 0 24 26"><path d="M3 2V22L8 17L12 24L16 22L12 15L21 14Z" fill="#111827" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>',
)}") 3 2, default`;

export type MassSpectrumChartOption = ComposeOption<
  | CustomSeriesOption
  | AriaComponentOption
  | DataZoomComponentOption
  | GridComponentOption
  | ToolboxComponentOption
  | TooltipComponentOption
>;

/** A centroid peak. `int` is the original, non-negative intensity. */
export interface SpectrumPeak {
  readonly mz: number;
  readonly int: number;
  /** Optional plain-text assignment shown in the tooltip, not above the peak. */
  readonly label?: string;
  /** Optional formula HTML. Takes precedence over label; only safe formatting is retained. */
  readonly labelHtml?: string;
}

export interface RelativeSpectrumPeak extends SpectrumPeak {
  readonly relativeIntensity: number;
}

export type SpectrumIntensityMode = "relative" | "absolute";

export interface MassSpectrumOptions {
  color?: string;
  textColor?: string;
  intensityMode?: SpectrumIntensityMode;
  labels?: boolean;
  mzDomain?: readonly [number, number];
  zoomDomain?: readonly [number, number];
  xLabel?: string;
}

export function getSpectrumIntensityMode(mode: unknown = "relative"): SpectrumIntensityMode {
  if (mode !== "relative" && mode !== "absolute") {
    throw new TypeError('Spectrum intensity mode must be "relative" or "absolute".');
  }
  return mode;
}

/** Validates and copies peaks without changing their order or combining equal m/z values. */
export function copySpectrumPeaks(peaks: readonly SpectrumPeak[]): SpectrumPeak[] {
  if (!Array.isArray(peaks)) throw new TypeError("Spectrum data must be an array of peaks.");

  for (const [index, peak] of peaks.entries()) {
    if (
      !peak ||
      !Number.isFinite(peak.mz) ||
      peak.mz < 0 ||
      !Number.isFinite(peak.int) ||
      peak.int < 0
    ) {
      throw new TypeError(`Peak ${index} must have finite, non-negative mz and int values.`);
    }
    if (
      (peak.label !== undefined && typeof peak.label !== "string") ||
      (peak.labelHtml !== undefined && typeof peak.labelHtml !== "string")
    ) {
      throw new TypeError(`Peak ${index} label and labelHtml must be strings.`);
    }
  }

  return peaks.map(({ mz, int, label, labelHtml }) => ({
    mz,
    int,
    ...(label === undefined ? {} : { label }),
    ...(labelHtml === undefined ? {} : { labelHtml }),
  }));
}

export function normalizeSpectrumPeaks(peaks: readonly SpectrumPeak[]): RelativeSpectrumPeak[] {
  const data = copySpectrumPeaks(peaks);
  let maximum = 0;
  for (const peak of data) maximum = Math.max(maximum, peak.int);
  return data.map((peak) => ({
    ...peak,
    relativeIntensity: maximum === 0 ? 0 : (peak.int / maximum) * 100,
  }));
}

export function getAutomaticMzDomain(peaks: readonly SpectrumPeak[]): readonly [number, number] {
  let maximumMz = 0;
  for (const peak of peaks) maximumMz = Math.max(maximumMz, peak.mz);
  const upperMz = maximumMz === 0 ? 1 : maximumMz + maximumMz * 0.05;
  return [0, upperMz];
}

function normalizeZoomDomain(
  domain: readonly [number, number],
  extent: readonly [number, number],
): readonly [number, number] {
  const tolerance =
    Math.max(Math.abs(extent[0]), Math.abs(extent[1]), Math.abs(extent[1] - extent[0]), 1) *
    Number.EPSILON *
    32;
  if (
    domain.length !== 2 ||
    !Number.isFinite(domain[0]) ||
    !Number.isFinite(domain[1]) ||
    domain[0] < extent[0] - tolerance ||
    domain[1] > extent[1] + tolerance ||
    domain[1] <= domain[0]
  ) {
    throw new RangeError(
      "Spectrum zoom range must be finite, increasing, and within the m/z range.",
    );
  }
  const normalized: readonly [number, number] = [
    Math.max(domain[0], extent[0]),
    Math.min(domain[1], extent[1]),
  ];
  if (normalized[1] <= normalized[0]) {
    throw new RangeError(
      "Spectrum zoom range must be finite, increasing, and within the m/z range.",
    );
  }
  return normalized;
}

/** NIST-inspired stick spectrum with one baseline-to-peak segment per row. */
export function createMassSpectrumChart(
  peaks: readonly SpectrumPeak[],
  options: MassSpectrumOptions = {},
): MassSpectrumChartOption {
  const data = normalizeSpectrumPeaks(peaks);
  const intensityMode = getSpectrumIntensityMode(options.intensityMode);
  const relative = intensityMode === "relative";
  let maximumIntensity = 0;
  for (const peak of data) maximumIntensity = Math.max(maximumIntensity, peak.int);
  const absoluteSplitNumber = 5;
  // ECharts rounds ticks to 20 decimal places. Pin bounds outside its safe rounding range.
  const fixedAbsoluteMaximum =
    maximumIntensity === 0
      ? 1
      : maximumIntensity / absoluteSplitNumber < 1e-20 || !Number.isFinite(maximumIntensity * 2)
        ? Math.min(Number.MAX_VALUE, maximumIntensity * 1.1)
        : undefined;
  const color = options.color ?? "currentColor";
  const textColor = options.textColor;
  const xLabel = options.xLabel ?? "m/z";
  const mzDomain = options.mzDomain ?? getAutomaticMzDomain(data);
  if (
    mzDomain.length !== 2 ||
    !Number.isFinite(mzDomain[0]) ||
    !Number.isFinite(mzDomain[1]) ||
    mzDomain[0] < 0 ||
    mzDomain[1] <= mzDomain[0]
  ) {
    throw new RangeError("Spectrum m/z range must have finite, increasing, non-negative bounds.");
  }
  const zoomDomain = normalizeZoomDomain(options.zoomDomain ?? mzDomain, mzDomain);
  const zoom = {
    xAxisIndex: 0,
    filterMode: "none" as const,
    startValue: zoomDomain[0],
    endValue: zoomDomain[1],
    rangeMode: ["value", "value"] as ["value", "value"],
    minValueSpan: (mzDomain[1] - mzDomain[0]) / 1_000_000,
  };

  return {
    animation: false,
    aria: { enabled: true },
    grid: { left: 75, right: 25, top: 45, bottom: 90 },
    toolbox: {
      right: 25,
      iconStyle: { borderColor: textColor },
      feature: { dataZoom: { xAxisIndex: 0, yAxisIndex: "none", filterMode: "none" } },
    },
    xAxis: {
      type: "value",
      min: mzDomain[0],
      max: mzDomain[1],
      name: xLabel,
      nameLocation: "middle",
      nameGap: 30,
      nameTextStyle: { fontSize: 16, color: textColor },
      axisLabel: { color: textColor },
      axisLine: { lineStyle: { color: textColor } },
      splitLine: { show: true },
    },
    yAxis: {
      type: "value",
      min: 0,
      max: relative ? 110 : fixedAbsoluteMaximum,
      boundaryGap: relative ? undefined : [0, "10%"],
      splitNumber: relative ? undefined : absoluteSplitNumber,
      interval: relative ? 20 : maximumIntensity > 0 ? fixedAbsoluteMaximum : undefined,
      name: relative ? "Relative intensity (%)" : "Absolute intensity",
      nameLocation: "middle",
      nameGap: 45,
      nameTextStyle: { fontSize: 16, color: textColor },
      axisLabel: {
        color: textColor,
        formatter: relative ? (value: number) => (value <= 100 ? String(value) : "") : undefined,
      },
      splitLine: { show: true },
    },
    dataZoom: [
      {
        ...zoom,
        id: "mz-inside",
        type: "inside",
        cursorGrab: plotCursor,
        cursorGrabbing: plotCursor,
      },
      { ...zoom, id: "mz-slider", type: "slider", bottom: 8, height: 22, showDataShadow: false },
    ],
    series: [
      {
        id: "peaks",
        type: "custom",
        coordinateSystem: "cartesian2d",
        clip: true,
        dimensions: ["mz", relative ? "relativeIntensity" : "int"],
        encode: { x: 0, y: 1, tooltip: [0, 1] },
        data: data.map((peak) => ({
          value: [peak.mz, relative ? peak.relativeIntensity : peak.int],
          ...peak,
          // Direct/keyboard inspection must distinguish peaks with identical m/z.
          tooltip: { trigger: "item" },
        })),
        renderItem: (_params, api) => {
          const mz = Number(api.value(0));
          const baseline = api.coord([mz, 0]);
          const top = api.coord([mz, Number(api.value(1))]);
          return {
            type: "group",
            children: [
              {
                type: "line",
                shape: { x1: baseline[0], y1: baseline[1], x2: top[0], y2: top[1] },
                style: { stroke: color, lineWidth: 1.5 },
                emphasis: { style: { lineWidth: 3 } },
              },
              ...(options.labels === false
                ? []
                : [
                    {
                      type: "text" as const,
                      silent: true,
                      style: {
                        x: top[0],
                        y: top[1]! - 7,
                        text: Number(mz.toFixed(4)).toString(),
                        fill: color,
                        fontSize: 12,
                        align: "center" as const,
                        verticalAlign: "bottom" as const,
                      },
                    },
                  ]),
            ],
          };
        },
      },
    ],
    tooltip: {
      trigger: "axis",
      confine: true,
      formatter: (params) => {
        const point = Array.isArray(params) ? params[0] : params;
        const peak = point && data[point.dataIndex];
        if (!peak) throw new RangeError("Spectrum tooltip peak is out of range.");
        return createSpectrumTooltip(peak, xLabel, intensityMode);
      },
    },
  };
}

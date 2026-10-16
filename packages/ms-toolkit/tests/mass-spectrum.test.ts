import { describe, expect, it } from "vite-plus/test";
import { createChartScene, renderChartSvg } from "@tanstack/charts";
import type { SceneNode } from "@tanstack/charts";
import {
  createMassSpectrumChart,
  copySpectrumPeaks,
  normalizeSpectrumPeaks,
} from "../src/charts/index.ts";

function flatten(nodes: readonly SceneNode[]): SceneNode[] {
  return nodes.flatMap((node) =>
    node.kind === "group" ? [node, ...flatten(node.children)] : [node],
  );
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
    const scene = createChartScene(createMassSpectrumChart(peaks), { width: 640, height: 360 });
    const group = flatten(scene.nodes).find((node) => node.key === "peaks");
    expect(group?.kind).toBe("group");
    if (group?.kind !== "group") throw new Error("Missing peak group");
    expect(group.children).toHaveLength(2);
    for (const [index, node] of group.children.entries()) {
      expect(node.kind).toBe("rule");
      if (node.kind !== "rule") throw new Error("Peak must be a segment");
      expect(node.x1).toBe(node.x2);
      expect(node.y1).toBe(scene.scales.y!.map(0));
      expect(node.y2).toBe(scene.scales.y!.map(index === 0 ? 100 : 25));
    }
    expect(scene.scales.x!.domain).toEqual([0, 59.85]);
    expect(scene.scales.y!.domain).toEqual([0, 110]);
    expect(
      scene.points.filter((point) => point.markId === "peaks").map((point) => point.datum),
    ).toEqual(normalizeSpectrumPeaks(peaks));
    expect(scene.points).toHaveLength(peaks.length);
  });

  it("supports color and optional peak labels", () => {
    const chart = createMassSpectrumChart(peaks, { color: "#2563eb", labels: false });
    const scene = createChartScene(chart, { width: 640, height: 360 });
    expect(flatten(scene.nodes).some((node) => node.key === "peak-labels")).toBe(false);
    const group = flatten(scene.nodes).find((node) => node.key === "peaks");
    if (group?.kind !== "group") throw new Error("Missing peak group");
    expect(group.children[0]?.style?.stroke).toBe("#2563eb");
    const labeled = createChartScene(createMassSpectrumChart(peaks), { width: 640, height: 360 });
    const labels = flatten(labeled.nodes).find((node) => node.key === "peak-labels");
    if (labels?.kind !== "group") throw new Error("Missing peak labels");
    expect(labels.children).toHaveLength(2);
  });

  it("anchors tooltips above the peak value instead of the stick midpoint", () => {
    const chart = createMassSpectrumChart(peaks);
    expect(chart.tooltip.anchor).toEqual({ x: "value", y: "value" });
    expect(chart.tooltip.placement).toBe("top");
    expect(chart.tooltip.offset).toBe(16);
    const scene = createChartScene(chart, { width: 640, height: 360 });
    for (const point of scene.points) {
      expect(scene.scales.x!.map(point.xValue)).toBe(point.x);
      expect(scene.scales.y!.map(point.yValue)).toBeLessThan(point.y);
    }
  });

  it.each([{ peaks: [] }, { peaks: [{ mz: 0, int: 0 }] }, { peaks: [{ mz: 43, int: 0 }] }])(
    "produces finite geometry for empty or zero-valued data: %o",
    ({ peaks }) => {
      const scene = createChartScene(createMassSpectrumChart(peaks), { width: 320, height: 240 });
      const svg = renderChartSvg(scene, { ariaLabel: "Spectrum" });
      expect(svg).not.toMatch(/NaN|Infinity/);
      expect(scene.scales.x!.map(0)).toBeGreaterThanOrEqual(0);
    },
  );

  it("scales stick geometry to the available width", () => {
    const chart = createMassSpectrumChart(peaks);
    const narrow = createChartScene(chart, { width: 320, height: 360 });
    const wide = createChartScene(chart, { width: 800, height: 360 });
    expect(wide.scales.x!.map(57)).toBeGreaterThan(narrow.scales.x!.map(57));
  });

  it("renders axis labels, precise peak labels and accessible SVG", () => {
    const chart = createMassSpectrumChart([{ mz: 43.123456, int: 1 }]);
    const scene = createChartScene(chart, { width: 640, height: 360 });
    const svg = renderChartSvg(scene, { ariaLabel: "Example spectrum" });
    expect(svg).toContain("Example spectrum");
    const labels = flatten(scene.nodes)
      .filter((node) => node.kind === "label")
      .map((node) => node.text);
    expect(labels).toContain("m/z");
    expect(labels).toContain("Relative intensity (%)");
    expect(labels).toContain("43.1235");
  });

  it("rejects an unrepresentable m/z display range", () => {
    expect(() => createMassSpectrumChart([{ mz: Number.MAX_VALUE, int: 1 }])).toThrow("range");
  });

  it("supports a focused m/z viewport without renormalizing its peaks", () => {
    const chart = createMassSpectrumChart(peaks, { mzDomain: [50, 60] });
    const scene = createChartScene(chart, { width: 640, height: 360 });
    expect(scene.scales.x!.domain).toEqual([50, 60]);
    expect(scene.points.find((point) => point.datum.mz === 57)?.datum.relativeIntensity).toBe(25);
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
    const scene = createChartScene(createMassSpectrumChart([peak]), { width: 640, height: 360 });
    expect(scene.points[0]?.datum.labelHtml).toBe(peak.labelHtml);
    const labels = flatten(scene.nodes).find((node) => node.key === "peak-labels");
    if (labels?.kind !== "group") throw new Error("Missing peak labels");
    expect(labels.children[0]).toMatchObject({ kind: "label", text: "43" });
  });

  it("preserves exact m/z and very small positive relative intensities in tooltip text", () => {
    const chart = createMassSpectrumChart([
      { mz: 46.04131623304093, int: 1 },
      { mz: 47.04467106811093, int: 1e-12 },
    ]);
    const scene = createChartScene(chart, { width: 640, height: 360 });
    const mzItem = chart.tooltip.items[0]!;
    const intensityItem = chart.tooltip.items[1]!;
    expect(mzItem.text!(scene.points[0]!)).toBe("46.04131623304093");
    expect(intensityItem.text!(scene.points[1]!)).toBe("1.00e-10%");
  });
});

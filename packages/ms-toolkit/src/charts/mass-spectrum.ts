import { defineChart } from '@tanstack/charts/scene';
import { frame } from '@tanstack/charts/frame';
import { link } from '@tanstack/charts/link';
import { createMark } from '@tanstack/charts';
import { text } from '@tanstack/charts/text';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { spectrumTooltip } from './spectrum-tooltip.ts';

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

export interface MassSpectrumOptions {
  color?: string;
  labels?: boolean;
  mzDomain?: readonly [number, number];
  xLabel?: string;
}

/** Validates and copies peaks without changing their order or combining equal m/z values. */
export function copySpectrumPeaks(peaks: readonly SpectrumPeak[]): SpectrumPeak[] {
  if (!Array.isArray(peaks)) throw new TypeError('Spectrum data must be an array of peaks.');

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
      (peak.label !== undefined && typeof peak.label !== 'string') ||
      (peak.labelHtml !== undefined && typeof peak.labelHtml !== 'string')
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

/** NIST-inspired stick spectrum with one baseline-to-peak segment per row. */
export function createMassSpectrumChart(
  peaks: readonly SpectrumPeak[],
  options: MassSpectrumOptions = {},
) {
  const data = normalizeSpectrumPeaks(peaks);
  const color = options.color ?? 'currentColor';
  const xLabel = options.xLabel ?? 'm/z';
  let maximumMz = 0;
  for (const peak of data) maximumMz = Math.max(maximumMz, peak.mz);
  const upperMz = maximumMz === 0 ? 1 : maximumMz + maximumMz * 0.05;
  const mzDomain = options.mzDomain ?? [0, upperMz];
  if (
    mzDomain.length !== 2 ||
    !Number.isFinite(mzDomain[0]) ||
    !Number.isFinite(mzDomain[1]) ||
    mzDomain[0] < 0 ||
    mzDomain[1] <= mzDomain[0]
  ) {
    throw new RangeError('Spectrum m/z range must have finite, increasing, non-negative bounds.');
  }
  const peakLabels = text(data, {
    id: 'peak-labels',
    x: 'mz',
    y: 'relativeIntensity',
    text: (peak) => Number(peak.mz.toFixed(4)).toString(),
    fill: color,
    fontSize: 12,
    dy: -7,
  });

  return defineChart({
    marks: [
      frame({ stroke: 'currentColor', strokeOpacity: 0.4 }),
      link(data, {
        id: 'peaks',
        x1: 'mz',
        x2: 'mz',
        y1: () => 0,
        y2: 'relativeIntensity',
        stroke: color,
        strokeWidth: 1.5,
        lineCap: 'butt',
      }),
      ...(options.labels === false
        ? []
        : [
            createMark<RelativeSpectrumPeak, number, number>((context) => ({
              ...peakLabels.initialize(context),
              // Labels decorate the sticks, not additional keyboard or tooltip targets.
              postDomain: (scene) => ({ ...scene, points: [] }),
            })),
          ]),
    ],
    scales: {
      x: {
        scale: scaleLinear().domain(mzDomain),
        viewport: options.mzDomain ? { domain: mzDomain } : undefined,
        grid: true,
        axis: { label: { text: xLabel, fontSize: 16 } },
      },
      y: {
        scale: scaleLinear().domain([0, 110]),
        grid: true,
        axis: {
          label: { text: 'Relative intensity (%)', fontSize: 16 },
          ticks: { values: [0, 20, 40, 60, 80, 100] },
        },
      },
    },
    tooltip: {
      use: spectrumTooltip,
      anchor: { x: 'value', y: 'value' },
      placement: 'top',
      offset: 16,
      items: [
        { field: 'mz', label: xLabel, text: (point) => point.datum.mz.toString() },
        {
          field: 'relativeIntensity',
          label: 'Relative intensity',
          text: (point) => {
            const intensity = point.datum.relativeIntensity;
            return `${intensity > 0 && intensity < 0.01 ? intensity.toExponential(2) : intensity.toFixed(2)}%`;
          },
        }
      ],
    },
  });
}

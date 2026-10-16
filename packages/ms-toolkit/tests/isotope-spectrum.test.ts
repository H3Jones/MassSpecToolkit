import { describe, expect, it } from 'vite-plus/test';
import rawPeaks from '../playground/ethanol-isotope-spectrum.json';
import { createMassSpectrumChart, normalizeSpectrumPeaks } from '../src/charts/index.ts';
import { formatIsotopeLabelHtml } from '../src/core/utils.ts';
import { createChartScene } from '@tanstack/charts';

describe('ethanol isotope snapshot example', () => {
  const peaks = rawPeaks.map((peak) => ({
    ...peak,
    labelHtml: formatIsotopeLabelHtml(peak.label),
  }));

  it('plots all 63 snapshot peaks at their unmodified neutral exact masses', () => {
    expect(peaks).toHaveLength(63);
    expect(peaks[0]?.mz).toBe(46.041864812949996);
    expect(peaks[62]?.mz).toBe(56.09047995172);
    expect(peaks[0]?.int).toBe(0.975662735452787);
    expect(peaks.reduce((sum, peak) => sum + peak.int, 0)).toBeCloseTo(1, 12);
    expect(peaks.every((peak) => peak.mz >= 45.5 && peak.mz <= 56.5)).toBe(true);
    expect(peaks[0]?.labelHtml).toBe('<sup>12</sup>C<sub>2</sub><sup>1</sup>H<sub>6</sub><sup>16</sup>O');
    expect(peaks.every((peak) => !peak.labelHtml?.includes('+'))).toBe(true);
    expect(peaks.some((peak) => peak.labelHtml?.includes('<sup>2</sup>H'))).toBe(true);
    expect(peaks.some((peak) => peak.labelHtml?.includes('<sup>13</sup>C'))).toBe(true);
    expect(normalizeSpectrumPeaks(peaks)[0]?.relativeIntensity).toBe(100);
    const scene = createChartScene(createMassSpectrumChart(peaks, {
      labels: false,
      mzDomain: [45.5, 56.5],
      xLabel: 'Mass (Da)',
    }), { width: 640, height: 360 });
    expect(scene.points).toHaveLength(63);
    expect(scene.points.every((point) => Boolean(point.datum.labelHtml))).toBe(true);
  });

  it('labels the neutral mass axis and tooltip in Da', () => {
    const chart = createMassSpectrumChart(peaks, { xLabel: 'Mass (Da)' });
    expect(chart.scales.x.axis.label.text).toBe('Mass (Da)');
    expect(chart.tooltip.items[0]?.label).toBe('Mass (Da)');
  });
});

import {
  callClient,
  type MassSpectrumResult,
  type SpectrumPeakResult,
  type TxtFormat,
} from "ms-toolkit/core";
import { normalizeSpectrumPeaks, type SpectrumPeak } from "ms-toolkit/charts";

export const spectrumReaders = [
  {
    id: "txt",
    name: "Text",
    extensions: [".txt", ".asc", ".csv", ".tsv"],
    description:
      "Unquoted text (.txt, .asc, .csv, .tsv) with whitespace, tab, comma, semicolon, or pipe separators. Headers are detected; headerless data uses the first two columns for m/z and intensity. S/N requires a recognized header or an explicit column mapping.",
    parse: (text: string, spec?: TxtFormat): Promise<MassSpectrumResult> =>
      callClient((client) => client.parseTxt(text, spec)),
  },
] as const;

export type MeasuredPeak = Pick<SpectrumPeakResult, keyof SpectrumPeakResult> & {
  readonly id: number;
  readonly relativeIntensity: number;
};

export interface SpectrumDataset {
  readonly id: string;
  readonly filename: string;
  readonly format: string;
  readonly peaks: readonly MeasuredPeak[];
  readonly chartPeaks: readonly SpectrumPeak[];
  readonly summary: {
    readonly minimumMz: number;
    readonly maximumMz: number;
    readonly basePeak: MeasuredPeak;
    readonly basePeakCount: number;
  };
}

export async function readSpectrumFile(file: File, spec?: TxtFormat): Promise<SpectrumDataset> {
  const reader = spectrumReaders.find((candidate) =>
    candidate.extensions.some((extension) => file.name.toLowerCase().endsWith(extension)),
  );
  if (!reader) {
    throw new Error("Unsupported file format. Choose a text (.txt, .asc, .csv, .tsv) peak list.");
  }
  const result = await reader.parse(await file.text(), spec);
  if (result.peaks.length === 0) {
    throw new Error("The file contains no peaks.");
  }
  const chartPeaks = normalizeSpectrumPeaks(
    result.peaks.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
  );
  const peaks = result.peaks.map((peak, index) => ({
    ...peak,
    id: index,
    relativeIntensity: chartPeaks[index].relativeIntensity,
  }));
  let minimumMz = peaks[0].mz;
  let maximumMz = peaks[0].mz;
  let basePeak = peaks[0];
  let basePeakCount = 0;
  for (const peak of peaks) {
    minimumMz = Math.min(minimumMz, peak.mz);
    maximumMz = Math.max(maximumMz, peak.mz);
    if (peak.intensity > basePeak.intensity) {
      basePeak = peak;
      basePeakCount = 1;
    } else if (peak.intensity === basePeak.intensity) {
      ++basePeakCount;
    }
  }
  return {
    id: crypto.randomUUID(),
    filename: file.name,
    format: reader.name,
    peaks,
    chartPeaks,
    summary: { minimumMz, maximumMz, basePeak, basePeakCount },
  };
}

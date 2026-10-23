import {
  callClient,
  type MassSpectrumResult,
  type SpectrumPeakResult,
  type SpectrumMetadata,
  type TxtFormat,
} from "ms-toolkit/core";
import { normalizeSpectrumPeaks, type SpectrumPeak } from "ms-toolkit/charts";
import {
  openSpectrumDatabase,
  type RetentionTimeRange,
  type SpectrumDataSource,
  type StoredSpectrumPeak,
} from "./spectrum-database";

export const spectrumReaders = [
  {
    id: "txt",
    name: "Text",
    extensions: [".txt", ".asc", ".csv", ".tsv"],
    description:
      "Unquoted text (.txt, .asc, .csv, .tsv) with whitespace, tab, comma, semicolon, or pipe separators. Headers are detected; headerless data uses the first two columns for m/z and intensity. S/N and RT (retention time) require recognized headers or explicit column mappings. RT retains the input file's units.",
    parse: (text: string, spec?: TxtFormat, filename?: string): Promise<MassSpectrumResult> =>
      callClient((client) => client.parseTxt(text, spec, filename)),
  },
] as const;

export type MeasuredPeak = Pick<SpectrumPeakResult, keyof SpectrumPeakResult> & {
  readonly id: number;
  readonly relativeIntensity: number;
};

export interface SpectrumView {
  readonly peaks: readonly MeasuredPeak[];
  readonly chartPeaks: readonly SpectrumPeak[];
  readonly summary?: {
    readonly minimumMz: number;
    readonly maximumMz: number;
    readonly basePeak: MeasuredPeak;
    readonly basePeakCount: number;
  };
}

export interface SpectrumDataset extends SpectrumView {
  readonly id: string;
  readonly metadata: Readonly<SpectrumMetadata>;
  readonly format: string;
  readonly source: SpectrumDataSource;
  readonly retentionTimeRange?: RetentionTimeRange;
}

/** Relative intensities use the entire selected RT interval, not the chart viewport. */
export function prepareSpectrumView(rows: readonly StoredSpectrumPeak[]): SpectrumView {
  if (!rows.length) return { peaks: [], chartPeaks: [] };
  const chartPeaks = normalizeSpectrumPeaks(
    rows.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
  );
  const peaks = rows.map((peak, index) => ({
    ...peak,
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
    peaks,
    chartPeaks,
    summary: { minimumMz, maximumMz, basePeak, basePeakCount },
  };
}

export async function readSpectrumFile(file: File, spec?: TxtFormat): Promise<SpectrumDataset> {
  const importStartedAt = performance.now();
  const reader = spectrumReaders.find((candidate) =>
    candidate.extensions.some((extension) => file.name.toLowerCase().endsWith(extension)),
  );
  if (!reader) {
    throw new Error("Unsupported file format. Choose a text (.txt, .asc, .csv, .tsv) peak list.");
  }
  const readStartedAt = performance.now();
  const text = await file.text();
  console.debug("[ms-toolkit] Spectrum file read", {
    bytes: file.size,
    durationMs: Math.round((performance.now() - readStartedAt) * 100) / 100,
  });
  const parseStartedAt = performance.now();
  const result = await reader.parse(text, spec, file.name);
  console.debug("[ms-toolkit] Spectrum file parsed", {
    peakCount: result.peaks.length,
    durationMs: Math.round((performance.now() - parseStartedAt) * 100) / 100,
  });
  if (result.peaks.length === 0) {
    throw new Error("The file contains no peaks.");
  }
  if (!result.metadata) {
    throw new Error("The spectrum reader did not return file metadata.");
  }
  const databaseStartedAt = performance.now();
  const source = await openSpectrumDatabase(result.peaks, result.metadata);
  try {
    const metadata = source.metadata;
    let retentionTimeRange: RetentionTimeRange | undefined;
    if (metadata.type === "Hyphenated") {
      const firstRt = metadata.minimumRetentionTime;
      if (firstRt === null) throw new Error("Hyphenated spectrum metadata is missing RT bounds.");
      retentionTimeRange = [firstRt, firstRt];
    }
    const view = prepareSpectrumView(await source.queryPeaks(retentionTimeRange));
    const dataset = {
      id: crypto.randomUUID(),
      metadata,
      format: reader.name,
      source,
      retentionTimeRange,
      ...view,
    };
    console.debug("[ms-toolkit] Spectrum import complete", {
      peakCount: metadata.peakCount,
      selectedPeakCount: view.peaks.length,
      databaseMs: Math.round((performance.now() - databaseStartedAt) * 100) / 100,
      durationMs: Math.round((performance.now() - importStartedAt) * 100) / 100,
    });
    return dataset;
  } catch (error) {
    source.dispose();
    throw error;
  }
}

import type { SpectrumMetadata, TxtFormat } from "ms-toolkit/core";
import type {
  RetentionTimeRange,
  SpectrumDataSource,
  SpectrumSelection,
  MeasuredPeak,
} from "./spectrum-database";
export type { MeasuredPeak } from "./spectrum-database";
import { openSpectrumFile, type SpectrumImportOptions } from "./spectrum-worker-client";
export type { SpectrumImportOptions } from "./spectrum-worker-client";

export const spectrumReaders = [
  {
    id: "txt",
    name: "Text",
    extensions: [".txt", ".asc", ".csv", ".tsv"],
    description:
      "Unquoted text (.txt, .asc, .csv, .tsv) with whitespace, tab, comma, semicolon, or pipe separators. Headers are detected; headerless data uses the first two columns for m/z and intensity. S/N and RT (retention time) require recognized headers or explicit column mappings. RT retains the input file's units.",
  },
] as const;

export interface SpectrumView extends SpectrumSelection {
  readonly firstPage: readonly MeasuredPeak[];
}

export interface SpectrumDataset extends SpectrumView {
  readonly id: string;
  readonly metadata: Readonly<SpectrumMetadata>;
  readonly format: string;
  readonly source: SpectrumDataSource;
  readonly retentionTimeRange?: RetentionTimeRange;
}

/** Fetch only aggregate statistics and the first ten rows, never the complete selection. */
export async function loadSpectrumView(
  source: SpectrumDataSource,
  range?: RetentionTimeRange,
): Promise<SpectrumView> {
  const [selection, firstPage] = await Promise.all([
    source.querySelection(range),
    source.queryTablePage({ pageIndex: 0, pageSize: 10, sorting: [] }, range),
  ]);
  return { ...selection, firstPage };
}

export async function readSpectrumFile(
  file: File,
  spec?: TxtFormat,
  options?: SpectrumImportOptions,
): Promise<SpectrumDataset> {
  options?.signal?.throwIfAborted();
  const importStartedAt = performance.now();
  const reader = spectrumReaders.find((candidate) =>
    candidate.extensions.some((extension) => file.name.toLowerCase().endsWith(extension)),
  );
  if (!reader) {
    throw new Error("Unsupported file format. Choose a text (.txt, .asc, .csv, .tsv) peak list.");
  }
  const source = options
    ? await openSpectrumFile(file, spec, options)
    : await openSpectrumFile(file, spec);
  console.debug("[ms-toolkit] Spectrum file read", {
    bytes: file.size,
    durationMs: Math.round(source.timings.readMs * 100) / 100,
  });
  console.debug("[ms-toolkit] Spectrum file parsed", {
    peakCount: source.metadata.peakCount,
    durationMs: Math.round(source.timings.parseMs * 100) / 100,
  });
  try {
    const metadata = source.metadata;
    let retentionTimeRange: RetentionTimeRange | undefined;
    if (metadata.type === "Hyphenated") {
      const firstRt = metadata.minimumRetentionTime;
      if (firstRt === null) throw new Error("Hyphenated spectrum metadata is missing RT bounds.");
      retentionTimeRange = [firstRt, firstRt];
    }
    const view = await loadSpectrumView(source, retentionTimeRange);
    options?.signal?.throwIfAborted();
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
      selectedPeakCount: view.peakCount,
      databaseMs: Math.round(source.timings.databaseMs * 100) / 100,
      durationMs: Math.round((performance.now() - importStartedAt) * 100) / 100,
    });
    return dataset;
  } catch (error) {
    source.dispose();
    throw error;
  }
}

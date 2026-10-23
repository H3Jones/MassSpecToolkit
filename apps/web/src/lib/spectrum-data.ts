import {
  ingestTxtFile,
  terminateClient,
  type TxtFormat,
  type SpectrumImportProgress,
} from "ms-toolkit/core";
import type { TicViewportRequest } from "ms-toolkit/charts";
import {
  openSpectrumDatabase,
  type RetentionTimeRange,
  type SpectrumDataSource,
  type SpectrumChartRequest,
  type SpectrumTableRequest,
} from "./spectrum-database";

/** One dataset per data worker; its Rust reader is released as soon as ingestion finishes. */
export function createSpectrumDataWorker() {
  let source: SpectrumDataSource | undefined;
  let started = false;
  let closed = false;
  let importFinished: Promise<void> | undefined;
  const controller = new AbortController();
  return {
    async importFile(
      file: File,
      spec?: TxtFormat,
      onProgress?: (progress: SpectrumImportProgress) => Promise<void>,
    ) {
      if (closed || started)
        throw new Error("This spectrum data worker is already used or closed.");
      started = true;
      let finish!: () => void;
      importFinished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        await onProgress?.({
          phase: "initializing",
          bytesRead: 0,
          totalBytes: file.size,
          peakCount: 0,
        });
        source = await openSpectrumDatabase((consume) => {
          if (closed) throw new Error("The spectrum data worker has been closed.");
          return ingestTxtFile(
            file,
            spec,
            consume,
            onProgress
              ? async (progress) => {
                  if (!closed) await onProgress(progress);
                }
              : undefined,
          );
        }, controller.signal);
        if (closed) {
          source.dispose();
          throw new Error("The spectrum data worker has been closed.");
        }
        return { metadata: source.metadata, timings: source.timings };
      } finally {
        terminateClient();
        finish();
      }
    },
    async querySelection(range?: RetentionTimeRange) {
      if (closed || !source) throw new Error("The spectrum database is not open.");
      return source.querySelection(range);
    },
    async queryChart(request: SpectrumChartRequest, range?: RetentionTimeRange) {
      if (closed || !source) throw new Error("The spectrum database is not open.");
      return source.queryChart(request, range);
    },
    async queryTablePage(request: SpectrumTableRequest, range?: RetentionTimeRange) {
      if (closed || !source) throw new Error("The spectrum database is not open.");
      return source.queryTablePage(request, range);
    },
    async queryTic(request: TicViewportRequest) {
      if (closed || !source) throw new Error("The spectrum database is not open.");
      return source.queryTic(request);
    },
    async dispose() {
      closed = true;
      controller.abort();
      terminateClient();
      source?.dispose();
      await importFinished;
    },
  };
}

export type SpectrumDataWorkerApi = ReturnType<typeof createSpectrumDataWorker>;

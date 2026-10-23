import { ingestTxtFile, terminateClient, type TxtFormat } from "ms-toolkit/core";
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
  return {
    async importFile(file: File, spec?: TxtFormat) {
      if (closed || started)
        throw new Error("This spectrum data worker is already used or closed.");
      started = true;
      let finish!: () => void;
      importFinished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      try {
        source = await openSpectrumDatabase((consume) => {
          if (closed) throw new Error("The spectrum data worker has been closed.");
          return ingestTxtFile(file, spec, consume);
        });
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
    async dispose() {
      closed = true;
      terminateClient();
      source?.dispose();
      await importFinished;
    },
  };
}

export type SpectrumDataWorkerApi = ReturnType<typeof createSpectrumDataWorker>;

import type { SpectrumDataset, SpectrumImportOptions } from "./spectrum";
import type { SpectrumImportProgress } from "ms-toolkit/core";

export type SpectrumImportState =
  | { readonly status: "empty"; readonly dataset?: undefined }
  | { readonly status: "loaded"; readonly dataset: SpectrumDataset }
  | {
      readonly status: "importing";
      readonly filename: string;
      readonly progress?: SpectrumImportProgress;
      readonly dataset?: SpectrumDataset;
    }
  | { readonly status: "cancelled"; readonly filename: string; readonly dataset?: SpectrumDataset }
  | {
      readonly status: "error";
      readonly filename: string;
      readonly error: Error;
      readonly dataset?: SpectrumDataset;
    };

type Importer = (file: File, options: SpectrumImportOptions) => Promise<SpectrumDataset>;

/** App-lifetime state; navigating away does not invalidate an active import. */
export function createSpectrumImportStore(
  importer: Importer = async (file, options) =>
    (await import("./spectrum")).readSpectrumFile(file, undefined, options),
) {
  let state: SpectrumImportState = { status: "empty" };
  let run = 0;
  let active: AbortController | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: SpectrumImportState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async importFile(this: void, file: File): Promise<void> {
      const current = ++run;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      publish({ status: "importing", filename: file.name, dataset: state.dataset });
      try {
        const dataset = await importer(file, {
          signal: controller.signal,
          onProgress(progress) {
            if (run === current && !controller.signal.aborted) {
              publish({
                status: "importing",
                filename: file.name,
                progress,
                dataset: state.dataset,
              });
            }
          },
        });
        if (run === current) {
          const previous = state.dataset;
          publish({ status: "loaded", dataset });
          if (previous && previous !== dataset) previous.source.dispose();
        } else {
          dataset.source.dispose();
        }
      } catch (error) {
        if (run === current) {
          publish({
            status: "error",
            filename: file.name,
            dataset: state.dataset,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      } finally {
        if (active === controller) active = undefined;
      }
    },
    cancelImport(this: void): void {
      if (state.status !== "importing") return;
      ++run;
      active?.abort();
      active = undefined;
      publish({ status: "cancelled", filename: state.filename, dataset: state.dataset });
    },
  };
}

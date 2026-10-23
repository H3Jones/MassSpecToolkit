import type { SpectrumDataset } from "./spectrum";

export type SpectrumImportState =
  | { readonly status: "empty"; readonly dataset?: undefined }
  | { readonly status: "loaded"; readonly dataset: SpectrumDataset }
  | { readonly status: "importing"; readonly filename: string; readonly dataset?: SpectrumDataset }
  | {
      readonly status: "error";
      readonly filename: string;
      readonly error: Error;
      readonly dataset?: SpectrumDataset;
    };

type Importer = (file: File) => Promise<SpectrumDataset>;

/** App-lifetime state; navigating away does not invalidate an active import. */
export function createSpectrumImportStore(
  importer: Importer = async (file) => (await import("./spectrum")).readSpectrumFile(file),
) {
  let state: SpectrumImportState = { status: "empty" };
  let run = 0;
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
      publish({ status: "importing", filename: file.name, dataset: state.dataset });
      try {
        const dataset = await importer(file);
        if (run === current) publish({ status: "loaded", dataset });
      } catch (error) {
        if (run === current) {
          publish({
            status: "error",
            filename: file.name,
            dataset: state.dataset,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      }
    },
  };
}

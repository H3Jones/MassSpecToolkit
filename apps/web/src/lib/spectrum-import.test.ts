import { describe, expect, it, vi } from "vite-plus/test";
import { createSpectrumImportStore } from "./spectrum-import";
import type { SpectrumDataset } from "./spectrum";

function dataset(id: string): SpectrumDataset {
  const peak = { id: 0, mz: 43, intensity: 1, signal_to_noise: 0, relativeIntensity: 100 };
  return {
    id,
    filename: `${id}.asc`,
    format: "ASC",
    peaks: [peak],
    chartPeaks: [{ mz: 43, int: 1 }],
    summary: { minimumMz: 43, maximumMz: 43, basePeak: peak, basePeakCount: 1 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("app-lifetime spectrum state", () => {
  it("publishes loading and success and permits reimporting the same file", async () => {
    const importer = vi.fn().mockResolvedValue(dataset("first"));
    const store = createSpectrumImportStore(importer);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    expect(store.getSnapshot()).toEqual({ status: "empty" });
    const file = new File([""], "first.asc");
    const pending = store.importFile(file);
    expect(store.getSnapshot()).toMatchObject({ status: "importing", filename: "first.asc" });
    await pending;
    expect(store.getSnapshot()).toEqual({ status: "loaded", dataset: dataset("first") });
    await store.importFile(file);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("retains the last valid dataset on failure and recovers on retry", async () => {
    const importer = vi
      .fn()
      .mockResolvedValueOnce(dataset("valid"))
      .mockRejectedValueOnce(new Error("line 2: invalid number"))
      .mockResolvedValueOnce(dataset("retry"));
    const store = createSpectrumImportStore(importer);
    await store.importFile(new File([""], "valid.asc"));
    await store.importFile(new File([""], "bad.asc"));
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      dataset: dataset("valid"),
      filename: "bad.asc",
      error: new Error("line 2: invalid number"),
    });
    await store.importFile(new File([""], "bad.asc"));
    expect(store.getSnapshot()).toEqual({ status: "loaded", dataset: dataset("retry") });
  });

  it.each(["success", "failure"] as const)(
    "ignores obsolete %s after a newer success",
    async (outcome) => {
      const old = deferred<SpectrumDataset>();
      const importer = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(dataset("new"));
      const store = createSpectrumImportStore(importer);
      const pending = store.importFile(new File([""], "old.asc"));
      await store.importFile(new File([""], "new.asc"));
      if (outcome === "success") old.resolve(dataset("old"));
      else old.reject(new Error("Obsolete error"));
      await pending;
      expect(store.getSnapshot()).toEqual({ status: "loaded", dataset: dataset("new") });
    },
  );

  it("does not let an obsolete success clear the newest error", async () => {
    const old = deferred<SpectrumDataset>();
    const importer = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockRejectedValueOnce("New import failed");
    const store = createSpectrumImportStore(importer);
    const pending = store.importFile(new File([""], "old.asc"));
    await store.importFile(new File([""], "new.asc"));
    old.resolve(dataset("old"));
    await pending;
    expect(store.getSnapshot()).toMatchObject({
      status: "error",
      error: new Error("New import failed"),
    });
  });

  it("keeps an active import across unsubscribe/resubscribe and isolates new app instances", async () => {
    const work = deferred<SpectrumDataset>();
    const store = createSpectrumImportStore(() => work.promise);
    const unsubscribe = store.subscribe(vi.fn());
    const pending = store.importFile(new File([""], "first.asc"));
    unsubscribe();
    const returnedPage = vi.fn();
    const unsubscribeReturnedPage = store.subscribe(returnedPage);
    work.resolve(dataset("first"));
    await pending;
    expect(store.getSnapshot()).toEqual({ status: "loaded", dataset: dataset("first") });
    expect(returnedPage).toHaveBeenCalledOnce();
    unsubscribeReturnedPage();
    expect(createSpectrumImportStore().getSnapshot()).toEqual({ status: "empty" });
  });

  it("keeps the latest import busy when an older import completes first", async () => {
    const old = deferred<SpectrumDataset>();
    const latest = deferred<SpectrumDataset>();
    const importer = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    const store = createSpectrumImportStore(importer);
    const pendingOld = store.importFile(new File([""], "old.asc"));
    const pendingLatest = store.importFile(new File([""], "latest.asc"));
    old.resolve(dataset("old"));
    await pendingOld;
    expect(store.getSnapshot()).toMatchObject({ status: "importing", filename: "latest.asc" });
    expect(store.getSnapshot().dataset).toBeUndefined();
    latest.resolve(dataset("latest"));
    await pendingLatest;
    expect(store.getSnapshot()).toEqual({ status: "loaded", dataset: dataset("latest") });
  });
});

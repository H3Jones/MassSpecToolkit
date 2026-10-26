import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpectrumMetadata, SpectrumImportProgress } from "ms-toolkit/core";
import { openSpectrumFile } from "./spectrum-worker-client";

const remote = vi.hoisted(() => ({
  importFile: vi.fn(),
  querySelection: vi.fn(),
  queryChart: vi.fn(),
  queryTic: vi.fn(),
  queryTablePage: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("comlink", () => ({ wrap: () => remote, proxy: (callback: unknown) => callback }));

class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();
  constructor() {
    super();
    TestWorker.instances.push(this);
  }
}

const metadata: SpectrumMetadata = {
  filename: "spectrum.asc",
  type: "Direct",
  peakCount: 1,
  minimumMz: 43,
  maximumMz: 43,
  minimumIntensity: 1,
  maximumIntensity: 1,
  minimumRetentionTime: null,
  maximumRetentionTime: null,
};
const rows = [{ id: 0, mz: 43, intensity: 1, signal_to_noise: null }];
beforeEach(() => {
  remote.importFile.mockReset().mockResolvedValue({
    metadata,
    timings: { readMs: 1, parseMs: 2, databaseMs: 3 },
  });
  remote.querySelection.mockReset().mockResolvedValue({ peakCount: 1 });
  remote.queryChart.mockReset().mockResolvedValue({ peaks: rows, visibleCount: 1 });
  remote.queryTic
    .mockReset()
    .mockResolvedValue({ points: [{ retentionTime: 0, intensity: 1 }], visibleCount: 1 });
  remote.queryTablePage.mockReset().mockResolvedValue(rows);
  remote.dispose.mockReset().mockResolvedValue(undefined);
  TestWorker.instances = [];
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("spectrum data worker client", () => {
  it("rejects pre-aborted imports without creating workers", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openSpectrumFile(new File([""], "cancel.asc"), undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(TestWorker.instances).toHaveLength(0);
  });

  it("aborts pending imports, suppresses late progress, and waits for child cleanup", async () => {
    let finishCleanup!: () => void;
    let report!: (progress: SpectrumImportProgress) => Promise<void>;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    remote.dispose.mockReturnValueOnce(cleanup);
    remote.importFile.mockImplementationOnce((_file, _spec, callback: typeof report) => {
      report = callback;
      return new Promise(() => {});
    });
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = openSpectrumFile(new File(["43 1"], "cancel.asc"), undefined, {
      signal: controller.signal,
      onProgress: progress,
    });
    await report({ phase: "reading", bytesRead: 1, totalBytes: 4, peakCount: 0 });
    expect(progress).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await report({ phase: "finalizing", bytesRead: 4, totalBytes: 4, peakCount: 1 });
    expect(progress).toHaveBeenCalledOnce();
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(TestWorker.instances[0].terminate).not.toHaveBeenCalled();
    finishCleanup();
    await cleanup;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("cancels first-view queries after ingestion has completed", async () => {
    const controller = new AbortController();
    const source = await openSpectrumFile(new File(["43 1"], "cancel.asc"), undefined, {
      signal: controller.signal,
    });
    remote.querySelection.mockReturnValueOnce(new Promise(() => {}));
    const pending = source.querySelection();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(remote.dispose).toHaveBeenCalledOnce();
  });

  it("passes a File, receives metadata, and requests rows separately", async () => {
    const file = new File(["43 1"], "spectrum.asc");
    const read = vi.spyOn(file, "text");
    const source = await openSpectrumFile(file);
    expect(remote.importFile).toHaveBeenCalledWith(file, undefined);
    expect(read).not.toHaveBeenCalled();
    expect(source.metadata).toEqual(metadata);
    expect(remote.querySelection).not.toHaveBeenCalled();
    expect(remote.queryChart).not.toHaveBeenCalled();
    expect(remote.queryTablePage).not.toHaveBeenCalled();
    expect(await source.querySelection([0, 0])).toEqual({ peakCount: 1 });
    expect(remote.querySelection).toHaveBeenCalledWith([0, 0]);
    const chart = { mzRange: [0, 100] as const, binCount: 50 };
    expect(await source.queryChart(chart, [0, 0])).toEqual({ peaks: rows, visibleCount: 1 });
    expect(remote.queryChart).toHaveBeenCalledWith(chart, [0, 0]);
    const tic = { rtRange: [0, 0] as const, binCount: 20 };
    expect(await source.queryTic(tic)).toEqual({
      points: [{ retentionTime: 0, intensity: 1 }],
      visibleCount: 1,
    });
    expect(remote.queryTic).toHaveBeenCalledWith(tic);
    const page = { pageIndex: 0, pageSize: 10, sorting: [{ id: "mz", desc: false }] };
    expect(await source.queryTablePage(page, [0, 0])).toEqual(rows);
    expect(remote.queryTablePage).toHaveBeenCalledWith(page, [0, 0]);
    source.dispose();
  });

  it("rejects pending queries immediately but waits for child-worker cleanup before terminating", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });

    remote.dispose.mockReturnValue(cleanup);
    remote.querySelection.mockReturnValue(new Promise(() => {}));
    const source = await openSpectrumFile(new File([""], "spectrum.asc"));
    const pending = source.querySelection();
    const rejected = expect(pending).rejects.toThrow("closed");
    source.dispose();
    source.dispose();
    await rejected;
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(TestWorker.instances[0].terminate).not.toHaveBeenCalled();
    finishCleanup();
    await cleanup;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await expect(source.querySelection()).rejects.toThrow("closed");
  });

  it("rejects in-flight and subsequent TIC queries on disposal", async () => {
    remote.queryTic.mockReturnValueOnce(new Promise(() => {}));
    const source = await openSpectrumFile(new File([""], "spectrum.asc"));
    const request = { rtRange: [0, 1] as const, binCount: 10 };
    const pending = source.queryTic(request);
    const rejected = expect(pending).rejects.toThrow("closed");
    source.dispose();
    await rejected;
    await expect(source.queryTic(request)).rejects.toThrow("closed");
  });

  it.each(["error", "messageerror"])(
    "rejects a pending import on %s and permits a new worker",
    async (type) => {
      remote.importFile.mockReturnValueOnce(new Promise(() => {}));
      const pending = openSpectrumFile(new File([""], "bad.asc"));
      const rejected = expect(pending).rejects.toThrow(/worker/);
      TestWorker.instances[0].dispatchEvent(new Event(type));
      await rejected;
      expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
      const source = await openSpectrumFile(new File([""], "retry.asc"));
      expect(TestWorker.instances).toHaveLength(2);
      source.dispose();
    },
  );

  it("rejects pending and subsequent queries after a crash", async () => {
    remote.querySelection.mockReturnValue(new Promise(() => {}));
    const source = await openSpectrumFile(new File([""], "spectrum.asc"));
    const pending = source.querySelection();
    const rejected = expect(pending).rejects.toThrow("stopped unexpectedly");
    TestWorker.instances[0].dispatchEvent(new Event("error"));
    await rejected;
    await expect(source.querySelection()).rejects.toThrow("stopped unexpectedly");
    source.dispose();
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("cleans up failed imports and preserves their diagnostics", async () => {
    remote.importFile.mockRejectedValueOnce(new Error("line 2: invalid peak"));
    await expect(openSpectrumFile(new File([""], "bad.asc"))).rejects.toThrow(
      "line 2: invalid peak",
    );
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });

  it("reports cleanup failures explicitly and still terminates the worker", async () => {
    remote.dispose.mockRejectedValueOnce(new Error("Cleanup protocol failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const source = await openSpectrumFile(new File([""], "spectrum.asc"));
      source.dispose();
      await Promise.resolve();
      expect(error).toHaveBeenCalledWith(
        "[ms-toolkit] Spectrum worker cleanup failed",
        new Error("Cleanup protocol failed"),
      );
      expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpectrumMetadata } from "ms-toolkit/core";
import { openSpectrumFile } from "./spectrum-worker-client";

const remote = vi.hoisted(() => ({
  importFile: vi.fn(),
  queryPeaks: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("comlink", () => ({ wrap: () => remote }));

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
  remote.queryPeaks.mockReset().mockResolvedValue(rows);
  remote.dispose.mockReset().mockResolvedValue(undefined);
  TestWorker.instances = [];
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("spectrum data worker client", () => {
  it("passes a File, receives metadata, and requests rows separately", async () => {
    const file = new File(["43 1"], "spectrum.asc");
    const read = vi.spyOn(file, "text");
    const source = await openSpectrumFile(file);
    expect(remote.importFile).toHaveBeenCalledWith(file, undefined);
    expect(read).not.toHaveBeenCalled();
    expect(source.metadata).toEqual(metadata);
    expect(remote.queryPeaks).not.toHaveBeenCalled();
    expect(await source.queryPeaks([0, 0])).toEqual(rows);
    expect(remote.queryPeaks).toHaveBeenCalledWith([0, 0]);
    source.dispose();
  });

  it("rejects pending queries immediately but waits for child-worker cleanup before terminating", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    remote.dispose.mockReturnValue(cleanup);
    remote.queryPeaks.mockReturnValue(new Promise(() => {}));
    const source = await openSpectrumFile(new File([""], "spectrum.asc"));
    const pending = source.queryPeaks();
    const rejected = expect(pending).rejects.toThrow("closed");
    source.dispose();
    source.dispose();
    await rejected;
    expect(remote.dispose).toHaveBeenCalledOnce();
    expect(TestWorker.instances[0].terminate).not.toHaveBeenCalled();
    finishCleanup();
    await cleanup;
    expect(TestWorker.instances[0].terminate).toHaveBeenCalledOnce();
    await expect(source.queryPeaks()).rejects.toThrow("closed");
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
    remote.queryPeaks.mockReturnValue(new Promise(() => {}));
    const source = await openSpectrumFile(new File([""], "spectrum.asc"));
    const pending = source.queryPeaks();
    const rejected = expect(pending).rejects.toThrow("stopped unexpectedly");
    TestWorker.instances[0].dispatchEvent(new Event("error"));
    await rejected;
    await expect(source.queryPeaks()).rejects.toThrow("stopped unexpectedly");
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

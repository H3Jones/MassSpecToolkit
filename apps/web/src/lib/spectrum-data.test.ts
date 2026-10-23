import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpectrumPeakColumns } from "ms-toolkit/core";
import { createSpectrumDataWorker } from "./spectrum-data";
import { openSpectrumDatabase, type SpectrumDataSource } from "./spectrum-database";

const mocks = vi.hoisted(() => ({
  ingestTxt: vi.fn(),
  terminateClient: vi.fn(),
}));
vi.mock("ms-toolkit/core", () => ({
  ingestTxtFile: mocks.ingestTxt,
  terminateClient: mocks.terminateClient,
}));
vi.mock("./spectrum-database", () => ({ openSpectrumDatabase: vi.fn() }));

const batch: SpectrumPeakColumns = {
  startIndex: 0,
  mz: new Float64Array([43]),
  intensity: new Float64Array([1]),
  signalToNoise: new Float64Array([0]),
  signalToNoiseValidity: new Uint8Array([0]),
  retentionTime: new Float64Array([0]),
  retentionTimeValidity: new Uint8Array([0]),
};
let source: SpectrumDataSource;
const consume = vi.fn(async (_batch: SpectrumPeakColumns) => {});
const querySelection = vi.fn(async () => ({ peakCount: 1 }));
const queryTablePage = vi.fn(async () => [
  { id: 0, mz: 43, intensity: 1, signal_to_noise: null, relativeIntensity: 100 },
]);
const queryChart = vi.fn(async () => ({
  peaks: [{ id: 0, mz: 43, intensity: 1, signal_to_noise: null }],
  visibleCount: 1,
}));
const dispose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  source = {
    metadata: {
      filename: "spectrum.asc",
      type: "Direct",
      peakCount: 1,
      minimumMz: 43,
      maximumMz: 43,
      minimumIntensity: 1,
      maximumIntensity: 1,
      minimumRetentionTime: null,
      maximumRetentionTime: null,
    },
    timings: { readMs: 1, parseMs: 2, databaseMs: 3 },
    querySelection,
    queryTablePage,
    queryChart,
    dispose,
  };
  mocks.ingestTxt.mockImplementation(async (_file, _spec, callback: typeof consume) => {
    await callback(batch);
    return { metadata: source.metadata, readMs: 1, parseMs: 2 };
  });
  vi.mocked(openSpectrumDatabase).mockImplementation(async (ingest) => {
    await ingest(consume);
    return source;
  });
});

describe("worker-side spectrum coordination", () => {
  it("forwards initialization and parser progress without publishing a partial source", async () => {
    const file = new File(["43 1"], "spectrum.asc");
    const report = vi.fn(async () => {});
    mocks.ingestTxt.mockImplementationOnce(
      async (
        _file,
        _spec,
        callback: typeof consume,
        progress: (value: unknown) => Promise<void>,
      ) => {
        await callback(batch);
        await progress({ phase: "reading", bytesRead: 4, totalBytes: 4, peakCount: 1 });
        return { metadata: source.metadata, readMs: 1, parseMs: 2 };
      },
    );
    const worker = createSpectrumDataWorker();
    await worker.importFile(file, undefined, report);
    expect(report).toHaveBeenNthCalledWith(1, {
      phase: "initializing",
      bytesRead: 0,
      totalBytes: 4,
      peakCount: 0,
    });
    expect(report).toHaveBeenNthCalledWith(2, {
      phase: "reading",
      bytesRead: 4,
      totalBytes: 4,
      peakCount: 1,
    });
    await worker.dispose();
  });

  it("connects columnar parsing to the insertion sink and releases the Rust worker after import", async () => {
    const worker = createSpectrumDataWorker();
    const file = new File(["43 1"], "spectrum.asc");
    await expect(worker.importFile(file)).resolves.toEqual({
      metadata: source.metadata,
      timings: source.timings,
    });
    expect(mocks.ingestTxt).toHaveBeenCalledWith(file, undefined, expect.any(Function), undefined);
    expect(consume).toHaveBeenCalledWith(batch);
    expect(mocks.terminateClient).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();
    expect(await worker.querySelection([0, 0])).toEqual({ peakCount: 1 });
    expect(querySelection).toHaveBeenCalledWith([0, 0]);
    const chart = { mzRange: [0, 100] as const, binCount: 50 };
    expect((await worker.queryChart(chart, [0, 0])).peaks).toHaveLength(1);
    expect(queryChart).toHaveBeenCalledWith(chart, [0, 0]);
    const page = { pageIndex: 0, pageSize: 10, sorting: [] };
    expect(await worker.queryTablePage(page, [0, 0])).toHaveLength(1);
    expect(queryTablePage).toHaveBeenCalledWith(page, [0, 0]);
    await worker.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(worker.querySelection()).rejects.toThrow("not open");
    await expect(worker.queryChart(chart)).rejects.toThrow("not open");
    await expect(worker.queryTablePage(page)).rejects.toThrow("not open");
    await expect(worker.importFile(file)).rejects.toThrow("closed");
  });

  it("rejects a second import without replacing the active dataset", async () => {
    const worker = createSpectrumDataWorker();
    const file = new File(["43 1"], "spectrum.asc");
    await worker.importFile(file);
    await expect(worker.importFile(file)).rejects.toThrow("already used");
    expect(mocks.ingestTxt).toHaveBeenCalledOnce();
    await worker.dispose();
  });

  it("releases the Rust worker and preserves parser or insertion failures", async () => {
    mocks.ingestTxt.mockRejectedValueOnce(new Error("line 2: invalid peak"));
    const worker = createSpectrumDataWorker();
    await expect(worker.importFile(new File([""], "bad.asc"))).rejects.toThrow(
      "line 2: invalid peak",
    );
    expect(mocks.terminateClient).toHaveBeenCalledOnce();
    await expect(worker.querySelection()).rejects.toThrow("not open");
    await worker.dispose();
  });

  it("waits for import cleanup when disposed before database initialization finishes", async () => {
    let initialized!: () => void;
    const ready = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    vi.mocked(openSpectrumDatabase).mockImplementationOnce(async (ingest) => {
      await ready;
      await ingest(consume);
      return source;
    });
    const worker = createSpectrumDataWorker();
    const pending = worker.importFile(new File([""], "obsolete.asc"));
    const rejected = expect(pending).rejects.toThrow("closed");
    const finished = vi.fn();
    const cleanup = worker.dispose().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    initialized();
    await rejected;
    await cleanup;
    expect(mocks.ingestTxt).not.toHaveBeenCalled();
    expect(finished).toHaveBeenCalledOnce();
  });

  it("rejects an in-flight parser request and awaits its cleanup on disposal", async () => {
    let rejectParser!: (error: Error) => void;
    let parserStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      parserStarted = resolve;
    });
    mocks.ingestTxt.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectParser = reject;
          parserStarted();
        }),
    );
    mocks.terminateClient.mockImplementationOnce(() => rejectParser(new Error("Parser closed")));
    const worker = createSpectrumDataWorker();
    const pending = worker.importFile(new File([""], "obsolete.asc"));
    await started;
    const rejected = expect(pending).rejects.toThrow("Parser closed");
    await worker.dispose();
    await rejected;
    expect(mocks.terminateClient).toHaveBeenCalledTimes(2);
    expect(dispose).not.toHaveBeenCalled();
  });
});

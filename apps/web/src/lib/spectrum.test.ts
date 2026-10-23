import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SpectrumMetadata, SpectrumPeakResult, TxtFormat } from "ms-toolkit/core";
import { readSpectrumFile } from "./spectrum";
import { openSpectrumFile } from "./spectrum-worker-client";

vi.mock("./spectrum-worker-client", () => ({ openSpectrumFile: vi.fn() }));

function mockParsedPeaks(peaks: readonly SpectrumPeakResult[]) {
  vi.mocked(openSpectrumFile).mockImplementation(async (file) => {
    const retentionTimes = peaks.flatMap((peak) =>
      peak.retention_time === undefined ? [] : [peak.retention_time],
    );
    const metadata: SpectrumMetadata = {
      filename: file.name,
      type: retentionTimes.length ? "Hyphenated" : "Direct",
      peakCount: peaks.length,
      minimumMz: Math.min(...peaks.map((peak) => peak.mz)),
      maximumMz: Math.max(...peaks.map((peak) => peak.mz)),
      minimumIntensity: Math.min(...peaks.map((peak) => peak.intensity)),
      maximumIntensity: Math.max(...peaks.map((peak) => peak.intensity)),
      minimumRetentionTime: retentionTimes.length ? Math.min(...retentionTimes) : null,
      maximumRetentionTime: retentionTimes.length ? Math.max(...retentionTimes) : null,
    };
    return {
      metadata,
      timings: { readMs: 1, parseMs: 2, databaseMs: 3 },
      queryPeaks: async () => peaks.map((peak, id) => ({ ...peak, id })),
      dispose: vi.fn(),
    };
  });
}

beforeEach(() => {
  vi.mocked(openSpectrumFile).mockReset();
});

describe("spectrum imports", () => {
  it("logs file-read, parser, and import durations without logging file contents", async () => {
    mockParsedPeaks([{ mz: 43, intensity: 100, signal_to_noise: null }]);
    const file = new File(["43 100"], "timed.asc");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await readSpectrumFile(file);
      expect(debug).toHaveBeenNthCalledWith(
        1,
        "[ms-toolkit] Spectrum file read",
        expect.objectContaining({ bytes: file.size, durationMs: expect.any(Number) }),
      );
      expect(debug).toHaveBeenNthCalledWith(
        2,
        "[ms-toolkit] Spectrum file parsed",
        expect.objectContaining({ peakCount: 1, durationMs: expect.any(Number) }),
      );
      expect(debug).toHaveBeenNthCalledWith(
        3,
        "[ms-toolkit] Spectrum import complete",
        expect.objectContaining({ peakCount: 1, durationMs: expect.any(Number) }),
      );
      expect(JSON.stringify(debug.mock.calls)).not.toContain("43 100");
    } finally {
      debug.mockRestore();
    }
  });

  it("imports text formats case-insensitively and preserves measurements and duplicate peak identities", async () => {
    mockParsedPeaks([
      { mz: 57, intensity: 250, signal_to_noise: null },
      { mz: 43, intensity: 1000, signal_to_noise: null },
      { mz: 57, intensity: 500, signal_to_noise: null },
    ]);
    const file = new File(["57 250 0\n43 1000 10\n57 500 1"], "example.ASC");
    const read = vi.spyOn(file, "text");
    const dataset = await readSpectrumFile(file);
    expect(openSpectrumFile).toHaveBeenCalledWith(file, undefined);
    expect(read).not.toHaveBeenCalled();
    expect(dataset).toMatchObject({
      metadata: { filename: "example.ASC", type: "Direct" },
      format: "Text",
      peaks: [
        { id: 0, mz: 57, intensity: 250, relativeIntensity: 25, signal_to_noise: null },
        { id: 1, mz: 43, intensity: 1000, relativeIntensity: 100, signal_to_noise: null },
        { id: 2, mz: 57, intensity: 500, relativeIntensity: 50, signal_to_noise: null },
      ],
      summary: { minimumMz: 43, maximumMz: 57, basePeak: { id: 1 }, basePeakCount: 1 },
    });
    const original = dataset.peaks.map((peak) => ({ ...peak }));
    const sorted = [...dataset.peaks].sort((a, b) => a.mz - b.mz);
    expect(sorted.map((peak) => peak.id)).toEqual([1, 0, 2]);
    expect(dataset.peaks).toEqual(original);
    expect((await readSpectrumFile(file)).id).not.toBe(dataset.id);
    for (const extension of ["TXT", "CSV", "TSV"]) {
      const textFile = new File(["57 250"], `example.${extension}`);
      expect((await readSpectrumFile(textFile)).format).toBe("Text");
    }
    const spec: TxtFormat = {
      delimiter: "whitespace",
      skip_lines: 0,
      column_count: 3,
      mz_column: 0,
      intensity_column: 1,
      signal_to_noise_column: null,
    };
    await readSpectrumFile(file, spec);
    expect(openSpectrumFile).toHaveBeenLastCalledWith(file, spec);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([0, 1000])(
    "reports tied base peaks without replacing the first peak (%s)",
    async (intensity) => {
      mockParsedPeaks([
        { mz: 2, intensity, signal_to_noise: 0 },
        { mz: 1, intensity, signal_to_noise: 0 },
      ]);
      const dataset = await readSpectrumFile(new File([""], "tied.asc"));
      expect(dataset.summary).toMatchObject({ basePeak: { id: 0 }, basePeakCount: 2 });
      expect(dataset.peaks.map((peak) => peak.relativeIntensity)).toEqual(
        intensity === 0 ? [0, 0] : [100, 100],
      );
    },
  );

  it.each([Number.MAX_VALUE, Number.MIN_VALUE])(
    "uses overflow-safe normalization (%s)",
    async (intensity) => {
      mockParsedPeaks([{ mz: 43, intensity, signal_to_noise: 0 }]);
      const dataset = await readSpectrumFile(new File([""], "extreme.asc"));
      expect(dataset.peaks[0].relativeIntensity).toBe(100);
    },
  );

  it("rejects unsupported formats before reading or parsing", async () => {
    const file = new File(["43 1 1"], "unsupported.mzml");
    const read = vi.spyOn(file, "text");
    await expect(readSpectrumFile(file)).rejects.toThrow("Unsupported file format");
    expect(read).not.toHaveBeenCalled();
    expect(openSpectrumFile).not.toHaveBeenCalled();
  });

  it("rejects empty spectra", async () => {
    vi.mocked(openSpectrumFile).mockRejectedValue(new Error("The file contains no peaks."));
    await expect(readSpectrumFile(new File([""], "empty.asc"))).rejects.toThrow("no peaks");
  });

  it("queries the first RT slice without losing the full database count", async () => {
    mockParsedPeaks([
      { mz: 43, intensity: 100, signal_to_noise: null, retention_time: 2.4 },
      { mz: 57, intensity: 200, signal_to_noise: null, retention_time: 2.5 },
    ]);
    const queryPeaks = vi
      .fn()
      .mockResolvedValue([
        { id: 0, mz: 43, intensity: 100, signal_to_noise: null, retention_time: 2.4 },
      ]);
    vi.mocked(openSpectrumFile).mockResolvedValue({
      timings: { readMs: 1, parseMs: 2, databaseMs: 3 },
      metadata: {
        filename: "gc.csv",
        type: "Hyphenated",
        peakCount: 2,
        minimumMz: 43,
        maximumMz: 57,
        minimumIntensity: 100,
        maximumIntensity: 200,
        minimumRetentionTime: 2.4,
        maximumRetentionTime: 2.5,
      },
      queryPeaks,
      dispose: vi.fn(),
    });
    const file = new File([""], "gc.csv");
    const dataset = await readSpectrumFile(file);
    expect(queryPeaks).toHaveBeenCalledWith([2.4, 2.4]);
    expect(dataset.retentionTimeRange).toEqual([2.4, 2.4]);
    expect(dataset.peaks).toHaveLength(1);
    expect(dataset.metadata.peakCount).toBe(2);
    expect(dataset.metadata).toBe(dataset.source.metadata);
    expect(openSpectrumFile).toHaveBeenCalledWith(file, undefined);
  });

  it("surfaces database errors and disposes a failed initial query", async () => {
    mockParsedPeaks([{ mz: 43, intensity: 100, signal_to_noise: null }]);
    vi.mocked(openSpectrumFile).mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(readSpectrumFile(new File([""], "db.asc"))).rejects.toThrow(
      "Database unavailable",
    );
    const dispose = vi.fn();
    vi.mocked(openSpectrumFile).mockResolvedValueOnce({
      timings: { readMs: 1, parseMs: 2, databaseMs: 3 },
      metadata: {
        filename: "db.asc",
        type: "Direct",
        peakCount: 1,
        minimumMz: 43,
        maximumMz: 43,
        minimumIntensity: 100,
        maximumIntensity: 100,
        minimumRetentionTime: null,
        maximumRetentionTime: null,
      },
      queryPeaks: async () => {
        throw new Error("Query failed");
      },
      dispose,
    });
    await expect(readSpectrumFile(new File([""], "db.asc"))).rejects.toThrow("Query failed");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("starts at RT zero for Hyphenated metadata", async () => {
    mockParsedPeaks([{ mz: 43, intensity: 100, signal_to_noise: null, retention_time: 0 }]);
    const dataset = await readSpectrumFile(new File([""], "zero.csv"));
    expect(dataset.metadata.type).toBe("Hyphenated");
    expect(dataset.retentionTimeRange).toEqual([0, 0]);
  });

  it("preserves parser and worker error diagnostics", async () => {
    vi.mocked(openSpectrumFile).mockRejectedValue(new Error("line 2: expected 3 columns"));
    await expect(readSpectrumFile(new File([""], "bad.asc"))).rejects.toThrow("line 2");
    vi.mocked(openSpectrumFile).mockRejectedValue(new Error("Unable to load WebAssembly"));
    await expect(readSpectrumFile(new File([""], "valid.asc"))).rejects.toThrow("WebAssembly");
  });

  it("surfaces worker-side file-read failures without reading on the UI thread", async () => {
    const file = new File([""], "unreadable.asc");
    const read = vi.spyOn(file, "text");
    vi.mocked(openSpectrumFile).mockRejectedValue(new Error("File access denied"));
    await expect(readSpectrumFile(file)).rejects.toThrow("File access denied");
    expect(read).not.toHaveBeenCalled();
  });
});

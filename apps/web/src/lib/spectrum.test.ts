import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readSpectrumFile } from "./spectrum";

const { parseAsc } = vi.hoisted(() => ({ parseAsc: vi.fn() }));
vi.mock("ms-toolkit/core", () => ({
  callClient: (request: (client: { parseAsc: typeof parseAsc }) => Promise<unknown>) =>
    request({ parseAsc }),
}));

beforeEach(() => {
  parseAsc.mockReset();
});

describe("spectrum imports", () => {
  it("dispatches ASC case-insensitively and preserves measurements and duplicate peak identities", async () => {
    parseAsc.mockResolvedValue({
      peaks: [
        { mz: 57, intensity: 250, signal_to_noise: 0 },
        { mz: 43, intensity: 1000, signal_to_noise: 10 },
        { mz: 57, intensity: 500, signal_to_noise: null },
      ],
    });
    const file = new File(["57 250 0\n43 1000 10\n57 500 1"], "example.ASC");
    const dataset = await readSpectrumFile(file);
    expect(parseAsc).toHaveBeenCalledWith(await file.text());
    expect(dataset).toMatchObject({
      filename: "example.ASC",
      format: "ASC",
      peaks: [
        { id: 0, mz: 57, intensity: 250, relativeIntensity: 25, signal_to_noise: 0 },
        { id: 1, mz: 43, intensity: 1000, relativeIntensity: 100, signal_to_noise: 10 },
        { id: 2, mz: 57, intensity: 500, relativeIntensity: 50, signal_to_noise: null },
      ],
      summary: { minimumMz: 43, maximumMz: 57, basePeak: { id: 1 }, basePeakCount: 1 },
    });
    const original = dataset.peaks.map((peak) => ({ ...peak }));
    const sorted = [...dataset.peaks].sort((a, b) => a.mz - b.mz);
    expect(sorted.map((peak) => peak.id)).toEqual([1, 0, 2]);
    expect(dataset.peaks).toEqual(original);
    expect((await readSpectrumFile(file)).id).not.toBe(dataset.id);
  });

  it.each([0, 1000])(
    "reports tied base peaks without replacing the first peak (%s)",
    async (intensity) => {
      parseAsc.mockResolvedValue({
        peaks: [
          { mz: 2, intensity, signal_to_noise: 0 },
          { mz: 1, intensity, signal_to_noise: 0 },
        ],
      });
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
      parseAsc.mockResolvedValue({ peaks: [{ mz: 43, intensity, signal_to_noise: 0 }] });
      const dataset = await readSpectrumFile(new File([""], "extreme.asc"));
      expect(dataset.peaks[0].relativeIntensity).toBe(100);
    },
  );

  it("rejects unsupported formats before reading or parsing", async () => {
    const file = new File(["43 1 1"], "not-an-asc.csv");
    const read = vi.spyOn(file, "text");
    await expect(readSpectrumFile(file)).rejects.toThrow("Unsupported file format");
    expect(read).not.toHaveBeenCalled();
    expect(parseAsc).not.toHaveBeenCalled();
  });

  it("rejects empty spectra", async () => {
    parseAsc.mockResolvedValue({ peaks: [] });
    await expect(readSpectrumFile(new File([""], "empty.asc"))).rejects.toThrow("no peaks");
  });

  it("preserves parser and worker error diagnostics", async () => {
    parseAsc.mockRejectedValue(new Error("line 2: expected 3 columns"));
    await expect(readSpectrumFile(new File([""], "bad.asc"))).rejects.toThrow("line 2");
    parseAsc.mockRejectedValue(new Error("Unable to load WebAssembly"));
    await expect(readSpectrumFile(new File([""], "valid.asc"))).rejects.toThrow("WebAssembly");
  });

  it("surfaces file-read failures without parsing", async () => {
    const file = new File([""], "unreadable.asc");
    vi.spyOn(file, "text").mockRejectedValue(new Error("File access denied"));
    await expect(readSpectrumFile(file)).rejects.toThrow("File access denied");
    expect(parseAsc).not.toHaveBeenCalled();
  });
});

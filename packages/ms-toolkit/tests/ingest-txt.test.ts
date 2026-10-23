import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { initSync, SpectrumPeakBatch, TxtSpectrumReader } from "../src/generated/wasm/ms_wasm.js";
import { api } from "../src/core/wasm.ts";
import type { SpectrumPeakColumns, TxtFormat } from "../src/core/types.ts";

beforeAll(async () => {
  const bytes = await readFile(new URL("../src/generated/wasm/ms_wasm_bg.wasm", import.meta.url));
  initSync({ module: bytes });
});
afterEach(() => vi.restoreAllMocks());

const spec: TxtFormat = {
  delimiter: "whitespace",
  skip_lines: 0,
  column_count: 2,
  mz_column: 0,
  intensity_column: 1,
  signal_to_noise_column: null,
};

describe("worker-owned text ingestion (real Rust WASM)", () => {
  it("transfers owned buffers in bounded batches without detaching the Rust reader", async () => {
    const text =
      "Rt,m/z,Intensity,S/N\n" +
      Array.from(
        { length: 32_769 },
        (_, id) =>
          `${id % 3},${43 + (id % 2)},${id === 0 ? Number.MAX_VALUE : id === 1 ? Number.MIN_VALUE : id},${id % 2}`,
      ).join("\n");
    const batches: SpectrumPeakColumns[] = [];
    const result = await api.ingestTxt(new File([text], "gc.csv"), undefined, async (batch) => {
      const columns = [
        batch.mz,
        batch.intensity,
        batch.signalToNoise,
        batch.signalToNoiseValidity,
        batch.retentionTime,
        batch.retentionTimeValidity,
      ];
      const buffers = columns.map((column) => {
        if (!(column.buffer instanceof ArrayBuffer)) throw new Error("Non-transferable column");
        return column.buffer;
      });
      batches.push(structuredClone(batch, { transfer: buffers }));
      expect(columns.every((column) => column.byteLength === 0)).toBe(true);
    });
    expect(batches.map((batch) => batch.startIndex)).toEqual([0, 16_384, 32_768]);
    expect(batches.map((batch) => batch.mz.length)).toEqual([16_384, 16_384, 1]);
    expect(Array.from(batches[0].intensity.slice(0, 3))).toEqual([
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      2,
    ]);
    expect(batches[2].intensity[0]).toBe(32_768);
    expect(batches[0].signalToNoiseValidity.every((value) => value === 1)).toBe(true);
    expect(batches[0].retentionTimeValidity.every((value) => value === 1)).toBe(true);
    expect(Array.from(batches[0].retentionTime.slice(0, 3))).toEqual([0, 1, 2]);
    expect(result.metadata).toEqual({
      filename: "gc.csv",
      type: "Hyphenated",
      peakCount: 32_769,
      minimumMz: 43,
      maximumMz: 44,
      minimumIntensity: Number.MIN_VALUE,
      maximumIntensity: Number.MAX_VALUE,
      minimumRetentionTime: 0,
      maximumRetentionTime: 2,
    });
    expect(result).toMatchObject({ readMs: expect.any(Number), parseMs: expect.any(Number) });
  });

  it("retains null columns separately from measured zero and honors explicit formats", async () => {
    const consume = vi.fn(async (batch: SpectrumPeakColumns) => {
      expect(Array.from(batch.mz)).toEqual([57, 43, 57]);
      expect(Array.from(batch.intensity)).toEqual([0, 1, 2]);
      expect(Array.from(batch.signalToNoiseValidity)).toEqual([0, 0, 0]);
      expect(Array.from(batch.retentionTimeValidity)).toEqual([0, 0, 0]);
    });
    const result = await api.ingestTxt(
      new File(["57 0\n43 1\n57 2\n"], "direct.asc"),
      spec,
      consume,
    );
    expect(consume).toHaveBeenCalledOnce();
    expect(result.metadata).toMatchObject({
      type: "Direct",
      peakCount: 3,
      minimumIntensity: 0,
      minimumRetentionTime: null,
      maximumRetentionTime: null,
    });
  });

  it("waits for each consumer before producing the next batch", async () => {
    let release!: () => void;
    let firstSeen!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      firstSeen = resolve;
    });
    const consume = vi.fn(async () => {
      if (consume.mock.calls.length === 1) {
        firstSeen();
        await blocked;
      }
    });
    const pending = api.ingestTxt(new File(["43 1\n".repeat(16_385)], "large.asc"), spec, consume);
    await seen;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(consume).toHaveBeenCalledOnce();
    release();
    await pending;
    expect(consume).toHaveBeenCalledTimes(2);
  });

  it("frees the current batch and reader on insertion failure and permits retry", async () => {
    const freeReader = vi.spyOn(TxtSpectrumReader.prototype, "free");
    const freeBatch = vi.spyOn(SpectrumPeakBatch.prototype, "free");
    const file = new File(["43 1\n".repeat(16_385)], "large.asc");
    const consume = vi.fn(async () => {
      throw new Error("Arrow insertion failed");
    });
    await expect(api.ingestTxt(file, spec, consume)).rejects.toThrow("Arrow insertion failed");
    expect(consume).toHaveBeenCalledOnce();
    expect(freeReader).toHaveBeenCalledOnce();
    expect(freeBatch).toHaveBeenCalledOnce();
    await expect(api.ingestTxt(file, spec, async () => {})).resolves.toMatchObject({
      metadata: { peakCount: 16_385 },
    });
  });

  it("surfaces file-read, empty-file, and full-file parser failures before emitting any batch", async () => {
    const consume = vi.fn(async () => {});
    const unreadable = new File(["43 1"], "unreadable.asc");
    vi.spyOn(unreadable, "text").mockRejectedValue(new Error("File access denied"));
    await expect(api.ingestTxt(unreadable, spec, consume)).rejects.toThrow("File access denied");
    await expect(api.ingestTxt(new File([""], "empty.asc"), spec, consume)).rejects.toThrow(
      "no peaks",
    );
    await expect(
      api.ingestTxt(new File(["43 1\n".repeat(16_384) + "57 bad"], "bad.asc"), spec, consume),
    ).rejects.toThrow('line 16385, column 2: "bad" is not a valid number');
    expect(consume).not.toHaveBeenCalled();
  });
});

import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  initSync,
  SpectrumPeakBatch,
  StreamingTxtSpectrumReader,
} from "../src/generated/wasm/ms_wasm.js";
import { api } from "../src/core/wasm.ts";
import type { SpectrumPeakColumns, TxtFormat, SpectrumImportProgress } from "../src/core/types.ts";

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
  it("streams split UTF-8/BOM/CRLF sequences and reports final full-file metadata", async () => {
    const text = "\ufeff# café 😀\r\nRt,m/z,Intensity,label\r\n0,43,2,α\r\n2.4,57,4,β";
    const bytes = new TextEncoder().encode(text);
    const file = new File([bytes], "utf8.csv");
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      type: "bytes",
      pull(controller) {
        controller.enqueue(bytes.slice(offset, ++offset));
        if (offset === bytes.length) controller.close();
      },
    });
    vi.spyOn(file, "stream").mockReturnValue(stream);
    const textRead = vi
      .spyOn(file, "text")
      .mockRejectedValue(new Error("Whole-file read forbidden"));
    const progress: SpectrumImportProgress[] = [];
    const result = await api.ingestTxt(
      file,
      undefined,
      async () => {},
      async (p) => {
        progress.push(p);
      },
    );
    expect(textRead).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    expect(result.metadata).toMatchObject({
      type: "Hyphenated",
      peakCount: 2,
      minimumMz: 43,
      maximumMz: 57,
      minimumIntensity: 2,
      maximumIntensity: 4,
      minimumRetentionTime: 0,
      maximumRetentionTime: 2.4,
    });
    expect(progress[0]).toEqual({
      phase: "reading",
      bytesRead: 0,
      totalBytes: bytes.length,
      peakCount: 0,
    });
    expect(progress.at(-1)).toEqual({
      phase: "finalizing",
      bytesRead: bytes.length,
      totalBytes: bytes.length,
      peakCount: 2,
    });
  });

  it("bounds native chunks even across a long line and a split multibyte character", async () => {
    const text = "\ufeff#" + "x".repeat(65_531) + "é😀\r\nm/z,Intensity\r\n43,2\r\n57,4";
    const push = vi.spyOn(StreamingTxtSpectrumReader.prototype, "push_chunk");
    const result = await api.ingestTxt(new File([text], "long.csv"), undefined, async () => {});
    expect(result.metadata.peakCount).toBe(2);
    expect(push.mock.calls.length).toBeGreaterThan(1);
    for (const [chunk] of push.mock.calls) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(65_540);
    }
  });

  it("cancels and unlocks the byte stream after an insertion failure", async () => {
    const file = new File(["43 1\n".repeat(100_000)], "cancel.asc");
    const stream = file.stream();
    const cancel = vi.spyOn(ReadableStreamBYOBReader.prototype, "cancel");
    vi.spyOn(file, "stream").mockReturnValue(stream);
    await expect(
      api.ingestTxt(file, spec, async () => {
        throw new Error("Insertion failed");
      }),
    ).rejects.toThrow("Insertion failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("rejects invalid UTF-8 and truncated streams instead of committing partial data", async () => {
    await expect(
      api.ingestTxt(new File([new Uint8Array([0xff])], "bad.asc"), spec, async () => {}),
    ).rejects.toBeInstanceOf(TypeError);
    const file = new File(["43 1\n"], "truncated.asc");
    vi.spyOn(file, "stream").mockReturnValue(new Blob(["43"]).stream());
    await expect(api.ingestTxt(file, spec, async () => {})).rejects.toThrow("entire file");
  });

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
    const push = vi.spyOn(StreamingTxtSpectrumReader.prototype, "push_chunk");
    const pending = api.ingestTxt(new File(["43 1\n".repeat(100_000)], "large.asc"), spec, consume);
    await seen;
    const chunks = push.mock.calls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(consume).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledTimes(chunks);
    release();
    await pending;
    expect(consume).toHaveBeenCalledTimes(7);
  });

  it("frees the current batch and reader on insertion failure and permits retry", async () => {
    const freeReader = vi.spyOn(StreamingTxtSpectrumReader.prototype, "free");
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

  it("surfaces file-read, empty-file, and late parser errors and stops emitting batches", async () => {
    const consume = vi.fn(async () => {});
    const unreadable = new File(["43 1"], "unreadable.asc");
    vi.spyOn(unreadable, "stream").mockImplementation(() => {
      throw new Error("File access denied");
    });
    await expect(api.ingestTxt(unreadable, spec, consume)).rejects.toThrow("File access denied");
    await expect(api.ingestTxt(new File([""], "empty.asc"), spec, consume)).rejects.toThrow(
      "no peaks",
    );
    await expect(
      api.ingestTxt(new File(["43 1\n".repeat(40_000) + "57 bad"], "bad.asc"), spec, consume),
    ).rejects.toThrow('line 40001, column 2: "bad" is not a valid number');
    expect(consume).toHaveBeenCalled();
  });
});

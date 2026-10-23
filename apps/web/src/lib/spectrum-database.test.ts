import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { tableToIPC, type Table } from "apache-arrow";
import type { ArrowInsertOptions } from "@duckdb/duckdb-wasm/blocking";
import type { SpectrumMetadata, SpectrumPeakColumns, SpectrumPeakResult } from "ms-toolkit/core";
import {
  openSpectrumDatabase,
  retentionTimePredicate,
  type SpectrumDataSource,
  type SpectrumIngestor,
} from "./spectrum-database";
import { prepareSpectrumView } from "./spectrum";

const databaseQueries = vi.hoisted(() => ({ run: vi.fn<(sql: string) => Table>() }));

// Use the real DuckDB WASM SQL/Arrow engine in Node; only the browser transport is replaced.
vi.mock("./duckdb", async () => {
  const duckdb = await import("@duckdb/duckdb-wasm/blocking");
  const require = createRequire(import.meta.url);
  return {
    async createSpectrumDatabase() {
      const db = await duckdb.createDuckDB(
        {
          mvp: {
            mainModule: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm"),
            mainWorker: require.resolve("@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs"),
          },
        },
        new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
        duckdb.NODE_RUNTIME,
      );
      await db.instantiate();
      db.open({ path: ":memory:" });
      const connection = db.connect();
      databaseQueries.run.mockImplementation((sql) => connection.query(sql));
      let closed = false;
      return {
        connection: {
          query: async (sql: string) => databaseQueries.run(sql),
          insertArrowTable: async (table: Table, options: ArrowInsertOptions) =>
            connection.insertArrowFromIPCStream(tableToIPC(table, "stream"), options),
        },
        async run<T>(operation: () => Promise<T>): Promise<T> {
          if (closed) throw new Error("The spectrum database has been closed.");
          return operation();
        },
        dispose() {
          if (closed) return;
          closed = true;
          connection.close();
          db.reset();
        },
      };
    },
  };
});

const sources: SpectrumDataSource[] = [];
afterEach(() => {
  for (const source of sources) source.dispose();
  sources.length = 0;
});

function columnsFor(peaks: readonly SpectrumPeakResult[], startIndex = 0): SpectrumPeakColumns {
  return {
    startIndex,
    mz: Float64Array.from(peaks, (peak) => peak.mz),
    intensity: Float64Array.from(peaks, (peak) => peak.intensity),
    signalToNoise: Float64Array.from(peaks, (peak) => peak.signal_to_noise ?? 0),
    signalToNoiseValidity: Uint8Array.from(peaks, (peak) => Number(peak.signal_to_noise !== null)),
    retentionTime: Float64Array.from(peaks, (peak) => peak.retention_time ?? 0),
    retentionTimeValidity: Uint8Array.from(peaks, (peak) =>
      Number(peak.retention_time !== undefined),
    ),
  };
}

function producer(
  peaks: readonly SpectrumPeakResult[],
  metadata = metadataFor(peaks),
): SpectrumIngestor {
  return async (consume) => {
    for (let offset = 0; offset < peaks.length; offset += 16_384) {
      await consume(columnsFor(peaks.slice(offset, offset + 16_384), offset));
    }
    return { metadata, readMs: 1, parseMs: 2 };
  };
}

function metadataFor(
  peaks: readonly SpectrumPeakResult[],
  filename = "spectrum.csv",
): SpectrumMetadata {
  const retentionTimes = peaks.flatMap((peak) =>
    peak.retention_time === undefined ? [] : [peak.retention_time],
  );
  return {
    filename,
    type: retentionTimes.length ? "Hyphenated" : "Direct",
    peakCount: peaks.length,
    minimumMz: Math.min(...peaks.map((peak) => peak.mz)),
    maximumMz: Math.max(...peaks.map((peak) => peak.mz)),
    minimumIntensity: Math.min(...peaks.map((peak) => peak.intensity)),
    maximumIntensity: Math.max(...peaks.map((peak) => peak.intensity)),
    minimumRetentionTime: retentionTimes.length ? Math.min(...retentionTimes) : null,
    maximumRetentionTime: retentionTimes.length ? Math.max(...retentionTimes) : null,
  };
}

async function open(peaks: readonly SpectrumPeakResult[], filename?: string) {
  const source = await openSpectrumDatabase(producer(peaks, metadataFor(peaks, filename)));
  sources.push(source);
  return source;
}

describe("in-memory spectrum queries (real DuckDB WASM)", () => {
  it("preserves original row identities, order, intensities, duplicates, and nullable S/N", async () => {
    const peaks = [
      { mz: 57, intensity: 250, signal_to_noise: null },
      { mz: 43, intensity: 1000, signal_to_noise: 0 },
      { mz: 57, intensity: 0, signal_to_noise: 2 },
    ];
    const source = await open(peaks);
    expect(source.metadata).toEqual({
      filename: "spectrum.csv",
      type: "Direct",
      peakCount: 3,
      minimumMz: 43,
      maximumMz: 57,
      minimumIntensity: 0,
      maximumIntensity: 1000,
      minimumRetentionTime: null,
      maximumRetentionTime: null,
    });
    const stored = databaseQueries.run("SELECT * FROM SpectrumMetadata");
    expect(stored.numRows).toBe(1);
    expect(stored.get(0)?.toJSON()).toEqual(source.metadata);
    expect(source.timings).toMatchObject({ readMs: 1, parseMs: 2, databaseMs: expect.any(Number) });
    expect(await source.queryPeaks()).toEqual(peaks.map((peak, id) => ({ ...peak, id })));
  });

  it("queries inclusive RT slices and ranges without merging equal masses", async () => {
    const source = await open([
      { mz: 57, intensity: 250, signal_to_noise: null, retention_time: 2.5 },
      { mz: 43, intensity: 1000, signal_to_noise: 0, retention_time: 2.4 },
      { mz: 57, intensity: 500, signal_to_noise: 2, retention_time: 2.5 },
    ]);
    expect(source.metadata).toMatchObject({
      type: "Hyphenated",
      minimumRetentionTime: 2.4,
      maximumRetentionTime: 2.5,
      minimumMz: 43,
      maximumMz: 57,
      minimumIntensity: 250,
      maximumIntensity: 1000,
    });
    expect((await source.queryPeaks([2.5, 2.5])).map((peak) => peak.id)).toEqual([0, 2]);
    expect((await source.queryPeaks([2.4, 2.5])).map((peak) => peak.id)).toEqual([0, 1, 2]);
    expect(await source.queryPeaks([3, 4])).toEqual([]);
    const view = prepareSpectrumView(await source.queryPeaks([2.5, 2.5]));
    expect(view.peaks.map((peak) => peak.relativeIntensity)).toEqual([50, 100]);
    expect(prepareSpectrumView([])).toEqual({ peaks: [], chartPeaks: [] });
    expect(databaseQueries.run("SELECT * FROM SpectrumMetadata").get(0)?.toJSON()).toEqual(
      source.metadata,
    );
    expect(source.metadata.maximumIntensity).toBe(1000);
  });

  it("retains null RT separately from zero and excludes missing RT from range queries", async () => {
    const source = await open([
      { mz: 43, intensity: 0, signal_to_noise: null },
      { mz: 43, intensity: 1, signal_to_noise: null, retention_time: 0 },
    ]);
    expect(source.metadata).toMatchObject({
      type: "Hyphenated",
      minimumRetentionTime: 0,
      maximumRetentionTime: 0,
    });
    expect((await source.queryPeaks()).map((peak) => peak.retention_time)).toEqual([undefined, 0]);
    expect((await source.queryPeaks([0, 0])).map((peak) => peak.id)).toEqual([1]);
  });

  it("inserts multiple Arrow batches and retains every row in a normal-sized spectrum", async () => {
    const peaks = Array.from({ length: 30_000 }, (_, id) => ({
      mz: 43 + id / 1000,
      intensity: id,
      signal_to_noise: id % 2 ? 0 : null,
      retention_time: id < 16_384 ? 1 : 2,
    }));
    const source = await open(peaks);
    const rows = await source.queryPeaks();
    expect(rows).toHaveLength(30_000);
    expect(rows[0]).toEqual({ id: 0, ...peaks[0] });
    expect(rows[29_999]).toEqual({ id: 29_999, ...peaks[29_999] });
    expect(await source.queryPeaks([2, 2])).toHaveLength(13_616);
  });

  it("rejects queries after disposal and supports idempotent cleanup", async () => {
    const source = await open([{ mz: 43, intensity: 100, signal_to_noise: null }]);
    source.dispose();
    source.dispose();
    await expect(source.queryPeaks()).rejects.toThrow("closed");
  });

  it("preserves extreme finite intensities without changing their scale", async () => {
    const source = await open([
      { mz: 43, intensity: Number.MAX_VALUE, signal_to_noise: null },
      { mz: 57, intensity: Number.MIN_VALUE, signal_to_noise: 0 },
    ]);
    const rows = await source.queryPeaks();
    expect(rows.map((peak) => peak.intensity)).toEqual([Number.MAX_VALUE, Number.MIN_VALUE]);
    expect(prepareSpectrumView(rows).peaks.map((peak) => peak.relativeIntensity)).toEqual([100, 0]);
  });

  it("rejects empty inputs and invalid RT measurements", async () => {
    const valid = [{ mz: 43, intensity: 100, signal_to_noise: null }];
    await expect(openSpectrumDatabase(producer([], metadataFor(valid)))).rejects.toThrow(
      "no peaks",
    );
    const invalid = [{ ...valid[0], retention_time: -1 }];
    await expect(openSpectrumDatabase(producer(invalid))).rejects.toThrow("Retention time");
  });

  it("stores filenames as values without interpreting quotes as SQL", async () => {
    const filename = "sample'); DROP TABLE peaks;--.csv";
    const source = await open([{ mz: 43, intensity: 100, signal_to_noise: null }], filename);
    expect(databaseQueries.run("SELECT filename FROM SpectrumMetadata").get(0)?.filename).toBe(
      filename,
    );
    expect(await source.queryPeaks()).toHaveLength(1);
  });

  it("rejects inconsistent metadata rather than storing an invalid classification", async () => {
    const peaks = [{ mz: 43, intensity: 100, signal_to_noise: null, retention_time: 0 }];
    const metadata = metadataFor(peaks);
    await expect(
      openSpectrumDatabase(producer(peaks, { ...metadata, peakCount: 2 })),
    ).rejects.toThrow("metadata does not match");
    await expect(
      openSpectrumDatabase(producer(peaks, { ...metadata, type: "Direct" })),
    ).rejects.toThrow("metadata type and RT bounds are inconsistent");
    await expect(
      openSpectrumDatabase(producer(peaks, { ...metadata, minimumRetentionTime: null })),
    ).rejects.toThrow("metadata type and RT bounds are inconsistent");
  });

  it.each(["oversized", "out of order", "unequal columns", "invalid validity"] as const)(
    "rejects %s columnar batches",
    async (invalid) => {
      const peaks = [{ mz: 43, intensity: 1, signal_to_noise: null }];
      const valid = columnsFor(peaks);
      const batch =
        invalid === "oversized"
          ? columnsFor(Array.from({ length: 16_385 }, () => peaks[0]))
          : invalid === "out of order"
            ? { ...valid, startIndex: 1 }
            : invalid === "unequal columns"
              ? { ...valid, intensity: new Float64Array(0) }
              : { ...valid, signalToNoiseValidity: new Uint8Array([2]) };
      await expect(
        openSpectrumDatabase(async (consume) => {
          await consume(batch);
          return { metadata: metadataFor(peaks), readMs: 0, parseMs: 0 };
        }),
      ).rejects.toThrow(/Spectrum (batch|column)/);
    },
  );

  it("propagates producer failures and leaves a later import usable", async () => {
    await expect(
      openSpectrumDatabase(async (consume) => {
        await consume(columnsFor([{ mz: 43, intensity: 1, signal_to_noise: null }]));
        throw new Error("Reader stopped at line 2");
      }),
    ).rejects.toThrow("Reader stopped at line 2");
    const source = await open([{ mz: 57, intensity: 2, signal_to_noise: null }]);
    expect(await source.queryPeaks()).toEqual([
      { id: 0, mz: 57, intensity: 2, signal_to_noise: null },
    ]);
  });
});

describe("RT query validation", () => {
  it.each([
    [-1, 0],
    [2, 1],
    [NaN, 1],
    [0, Infinity],
  ] as const)("rejects invalid bounds %s - %s", (minimum, maximum) => {
    expect(() => retentionTimePredicate([minimum, maximum])).toThrow("RT bounds");
  });
});

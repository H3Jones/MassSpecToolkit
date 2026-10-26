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
  type RetentionTimeRange,
} from "./spectrum-database";
import { selectSpectrumPeaks } from "../../../../packages/ms-toolkit/src/charts/mass-spectrum";

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

async function queryRows(source: SpectrumDataSource, range?: RetentionTimeRange, pageIndex = 0) {
  const rows = await source.queryTablePage({ pageIndex, pageSize: 100, sorting: [] }, range);
  return rows.map(({ relativeIntensity: _relativeIntensity, ...peak }) => peak);
}

describe("in-memory spectrum queries (real DuckDB WASM)", () => {
  it("sums original intensities per exact RT, excluding null RT and retaining zero and duplicate masses", async () => {
    const source = await open([
      { mz: 43, intensity: 10000, signal_to_noise: null },
      { mz: 43, intensity: 0, signal_to_noise: null, retention_time: 0 },
      { mz: 43, intensity: 20, signal_to_noise: null, retention_time: 2 },
      { mz: 43, intensity: 30, signal_to_noise: null, retention_time: 2 },
      { mz: 80, intensity: 10, signal_to_noise: null, retention_time: 1 },
    ]);
    const request = { rtRange: [0, 2] as const, binCount: 10 };
    const expected = {
      points: [
        { retentionTime: 0, intensity: 0 },
        { retentionTime: 1, intensity: 10 },
        { retentionTime: 2, intensity: 50 },
      ],
      visibleCount: 3,
    };
    expect(await source.queryTic(request)).toEqual(expected);
    await source.querySelection([1, 1]);
    expect(await source.queryTic(request)).toEqual(expected);
    expect(await source.queryTic({ rtRange: [2, 2], binCount: 1 })).toEqual({
      points: [{ retentionTime: 2, intensity: 50 }],
      visibleCount: 1,
    });
    expect(await source.queryTic({ rtRange: [3, 4], binCount: 10 })).toEqual({
      points: [],
      visibleCount: 0,
    });
    expect((await queryRows(source, [2, 2])).map((peak) => peak.intensity)).toEqual([20, 30]);
  });

  it("bounds TIC overviews after scan aggregation, breaks ties by RT, and resolves omitted scans on zoom", async () => {
    const peaks = Array.from({ length: 2400 }, (_, id) => ({
      mz: 43,
      intensity: id % 2 === 0 ? 10 : 5,
      signal_to_noise: null,
      retention_time: Math.floor(id / 2),
    }));
    const source = await open(peaks);
    const overview = await source.queryTic({ rtRange: [0, 1199], binCount: 2 });
    expect(overview).toEqual({
      points: [
        { retentionTime: 0, intensity: 15 },
        { retentionTime: 600, intensity: 15 },
      ],
      visibleCount: 1200,
    });
    const zoom = await source.queryTic({ rtRange: [5, 8], binCount: 100 });
    expect(zoom.points.map((point) => point.retentionTime)).toEqual([5, 6, 7, 8]);
    expect(zoom.visibleCount).toBe(4);
    expect(
      (await source.queryTic({ rtRange: [0, 1199], binCount: 10000 })).points.length,
    ).toBeLessThanOrEqual(1000);
  });

  it("selects a bin's strongest complete scan rather than its strongest individual measurement", async () => {
    const source = await open([
      { mz: 43, intensity: 60, signal_to_noise: null, retention_time: 1 },
      { mz: 44, intensity: 60, signal_to_noise: null, retention_time: 1 },
      { mz: 43, intensity: 100, signal_to_noise: null, retention_time: 2 },
    ]);
    expect(await source.queryTic({ rtRange: [1, 2], binCount: 1 })).toEqual({
      points: [{ retentionTime: 1, intensity: 120 }],
      visibleCount: 2,
    });
  });

  it("returns an empty TIC for Direct spectra and rejects malformed requests before querying", async () => {
    const source = await open([{ mz: 43, intensity: 10, signal_to_noise: null }]);
    expect(await source.queryTic({ rtRange: [0, 1], binCount: 1 })).toEqual({
      points: [],
      visibleCount: 0,
    });
    const previousCalls = databaseQueries.run.mock.calls.length;
    for (const rtRange of [
      [-1, 1],
      [2, 1],
      [NaN, 1],
      [0, Infinity],
    ] as const) {
      await expect(source.queryTic({ rtRange, binCount: 1 })).rejects.toThrow("TIC RT bounds");
    }
    for (const binCount of [0, -1, 1.5, NaN, Infinity]) {
      await expect(source.queryTic({ rtRange: [0, 1], binCount })).rejects.toThrow("TIC bin count");
    }
    expect(databaseQueries.run.mock.calls.length).toBe(previousCalls);
  });

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
    expect(await queryRows(source)).toEqual(peaks.map((peak, id) => ({ ...peak, id })));
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
    expect((await queryRows(source, [2.5, 2.5])).map((peak) => peak.id)).toEqual([0, 2]);
    expect((await queryRows(source, [2.4, 2.5])).map((peak) => peak.id)).toEqual([0, 1, 2]);
    expect(await queryRows(source, [3, 4])).toEqual([]);
    const page = await source.queryTablePage(
      { pageIndex: 0, pageSize: 10, sorting: [] },
      [2.5, 2.5],
    );
    expect(page.map((peak) => peak.relativeIntensity)).toEqual([50, 100]);
    expect(await source.querySelection([3, 4])).toEqual({ peakCount: 0 });
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
    expect((await queryRows(source)).map((peak) => peak.retention_time)).toEqual([undefined, 0]);
    expect((await queryRows(source, [0, 0])).map((peak) => peak.id)).toEqual([1]);
  });

  it("inserts multiple Arrow batches and retains every row in a normal-sized spectrum", async () => {
    const peaks = Array.from({ length: 30_000 }, (_, id) => ({
      mz: 43 + id / 1000,
      intensity: id,
      signal_to_noise: id % 2 ? 0 : null,
      retention_time: id < 16_384 ? 1 : 2,
    }));
    const source = await open(peaks);
    const rows = await queryRows(source);
    expect((await source.querySelection()).peakCount).toBe(30_000);
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({ id: 0, ...peaks[0] });
    expect((await queryRows(source, undefined, 299))[99]).toEqual({ id: 29_999, ...peaks[29_999] });
    expect((await source.querySelection([2, 2])).peakCount).toBe(13_616);
  });

  it("shares concurrent selection queries for the same RT range and refreshes on range changes", async () => {
    const source = await open([
      { mz: 43, intensity: 100, signal_to_noise: null, retention_time: 1 },
      { mz: 57, intensity: 50, signal_to_noise: null, retention_time: 2 },
    ]);
    databaseQueries.run.mockClear();

    const selections = await Promise.all([
      source.querySelection([1, 1]),
      source.querySelection([1, 1]),
    ]);
    expect(selections[0]).toEqual(selections[1]);
    expect(selections[0].summary?.basePeak.retention_time).toBe(1);
    expect(databaseQueries.run).toHaveBeenCalledTimes(1);

    await source.querySelection([1, 1]);
    expect(databaseQueries.run).toHaveBeenCalledTimes(1);
    expect((await source.querySelection([2, 2])).summary?.basePeak.retention_time).toBe(2);
    expect(databaseQueries.run).toHaveBeenCalledTimes(2);
    expect((await source.querySelection([1, 1])).summary?.basePeak.retention_time).toBe(1);
    expect(databaseQueries.run).toHaveBeenCalledTimes(3);
  });

  it("evicts failed selection queries so the same range can be retried", async () => {
    const source = await open([{ mz: 43, intensity: 100, signal_to_noise: null }]);
    databaseQueries.run.mockClear();
    databaseQueries.run.mockImplementationOnce(() => {
      throw new Error("Selection query failed.");
    });

    await expect(source.querySelection()).rejects.toThrow("Selection query failed.");
    expect((await source.querySelection()).peakCount).toBe(1);
    expect(databaseQueries.run).toHaveBeenCalledTimes(2);
    await source.querySelection();
    expect(databaseQueries.run).toHaveBeenCalledTimes(2);
  });

  it("rejects queries after disposal and supports idempotent cleanup", async () => {
    const source = await open([{ mz: 43, intensity: 100, signal_to_noise: null }]);
    await source.querySelection();
    source.dispose();
    source.dispose();
    await expect(source.querySelection()).rejects.toThrow("closed");
    await expect(queryRows(source)).rejects.toThrow("closed");
    await expect(source.queryChart({ mzRange: [0, 100], binCount: 10 })).rejects.toThrow("closed");
    await expect(source.queryTic({ rtRange: [0, 1], binCount: 10 })).rejects.toThrow("closed");
  });

  it("preserves extreme finite intensities without changing their scale", async () => {
    const source = await open([
      { mz: 43, intensity: Number.MAX_VALUE, signal_to_noise: null },
      { mz: 57, intensity: Number.MIN_VALUE, signal_to_noise: 0 },
    ]);
    const rows = await source.queryTablePage({ pageIndex: 0, pageSize: 10, sorting: [] });
    expect(rows.map((peak) => peak.intensity)).toEqual([Number.MAX_VALUE, Number.MIN_VALUE]);
    expect(rows.map((peak) => peak.relativeIntensity)).toEqual([100, 0]);
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
    expect(await queryRows(source)).toHaveLength(1);
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
    expect(await queryRows(source)).toEqual([
      { id: 0, mz: 57, intensity: 2, signal_to_noise: null },
    ]);
  });

  it("matches the existing strongest-per-bin selector exactly with bounded SQL output", async () => {
    const peaks = Array.from({ length: 30_000 }, (_, id) => ({
      mz: 43 + ((id * 7919) % 30_000) / 1000,
      intensity: id % 97 === 0 ? Number.MAX_VALUE : (id * 1543) % 137,
      signal_to_noise: id % 2 ? 0 : null,
      retention_time: id % 3 ? 1 : 2,
    }));
    const source = await open(peaks);
    for (const range of [undefined, [1, 1] as const]) {
      const candidates = peaks
        .map((peak, id) => ({ ...peak, id }))
        .filter((peak) => !range || peak.retention_time === 1);
      for (const binCount of [1, 4, 17, 783, 1000, 100_000]) {
        const request = { mzRange: [43, 73] as const, binCount };
        const expected = selectSpectrumPeaks(
          candidates.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
          request.mzRange,
          binCount,
        );
        const actual = await source.queryChart(request, range);
        expect(actual.visibleCount).toBe(candidates.length);
        expect(actual.peaks).toEqual(expected.indices.map((index) => candidates[index]));
        expect(actual.peaks.length).toBeLessThanOrEqual(Math.min(binCount, 1000));
      }
    }
  });

  it("includes chart boundaries, resolves ties by original ID, and reveals nearby peaks on zoom", async () => {
    const peaks = [
      { mz: 202.68987, intensity: 454818, signal_to_noise: null },
      { mz: 202.69008, intensity: 354454, signal_to_noise: null },
      { mz: 202.6904, intensity: 473045, signal_to_noise: null },
      { mz: 202.69099, intensity: 351926, signal_to_noise: null },
      { mz: 202.6914, intensity: 300000, signal_to_noise: null },
      { mz: 202.6904, intensity: 473045, signal_to_noise: 0 },
      { mz: 43, intensity: 1000000, signal_to_noise: 0 },
    ];
    const source = await open(peaks);
    expect(
      (await source.queryChart({ mzRange: [0, 250], binCount: 783 })).peaks.map((p) => p.id),
    ).toEqual([2, 6]);
    const zoomed = await source.queryChart({ mzRange: [peaks[0].mz, peaks[4].mz], binCount: 783 });
    expect(zoomed.peaks.map((p) => p.id)).toEqual([0, 1, 2, 3, 4]);
    expect(zoomed.visibleCount).toBe(6);
    expect(await source.queryChart({ mzRange: [300, 400], binCount: 10 })).toEqual({
      peaks: [],
      visibleCount: 0,
    });
    const summary = await source.querySelection();
    expect(summary).toMatchObject({
      peakCount: 7,
      summary: { basePeak: { id: 6 }, maximumIntensity: 1000000 },
    });
  });

  it("keeps full-selection base peaks, including zero-intensity ties, independent of pages", async () => {
    const source = await open([
      { mz: 57, intensity: 0, signal_to_noise: 0, retention_time: 1 },
      { mz: 43, intensity: 0, signal_to_noise: null, retention_time: 1 },
      { mz: 99, intensity: 1000, signal_to_noise: null, retention_time: 2 },
    ]);
    expect(await source.querySelection([1, 1])).toMatchObject({
      peakCount: 2,
      summary: {
        minimumMz: 43,
        maximumMz: 57,
        maximumIntensity: 0,
        basePeak: { id: 0, relativeIntensity: 0 },
        basePeakCount: 2,
      },
    });
    const page = await source.queryTablePage(
      { pageIndex: 1, pageSize: 1, sorting: [{ id: "relativeIntensity", desc: true }] },
      [1, 1],
    );
    expect(page).toMatchObject([{ id: 1, relativeIntensity: 0 }]);
    expect(source.metadata.maximumIntensity).toBe(1000);
  });

  it("paginates database-side sorting with stable ties and missing values last", async () => {
    const source = await open([
      { mz: 57, intensity: 20, signal_to_noise: null },
      { mz: 43, intensity: 100, signal_to_noise: 0, retention_time: 0 },
      { mz: 57, intensity: 100, signal_to_noise: 2, retention_time: 1 },
      { mz: 43, intensity: 10, signal_to_noise: 0 },
      { mz: 57, intensity: 30, signal_to_noise: null, retention_time: 0 },
    ]);
    for (const desc of [false, true]) {
      const ids: number[] = [];
      for (let pageIndex = 0; pageIndex < 3; pageIndex++) {
        const page = await source.queryTablePage({
          pageIndex,
          pageSize: 2,
          sorting: [{ id: "mz", desc }],
        });
        expect(page.length).toBeLessThanOrEqual(2);
        ids.push(...page.map((p) => p.id));
      }
      expect(ids).toEqual(desc ? [0, 2, 4, 1, 3] : [1, 3, 0, 2, 4]);
    }
    expect(
      (
        await source.queryTablePage({
          pageIndex: 0,
          pageSize: 10,
          sorting: [{ id: "signal_to_noise", desc: true }],
        })
      ).map((p) => p.id),
    ).toEqual([2, 1, 3, 0, 4]);
    expect(
      (
        await source.queryTablePage({
          pageIndex: 0,
          pageSize: 10,
          sorting: [{ id: "retention_time", desc: false }],
        })
      ).map((p) => p.id),
    ).toEqual([1, 4, 2, 0, 3]);
    expect(
      (await source.queryTablePage({ pageIndex: 1, pageSize: 2, sorting: [] })).map((p) => p.id),
    ).toEqual([2, 3]);
    expect(
      (await source.queryTablePage({ pageIndex: 0, pageSize: 1, sorting: [] }))[0]
        .relativeIntensity,
    ).toBe(20);
  });

  it("sorts displayed relative intensities correctly even when finite values underflow to zero", async () => {
    const source = await open([
      { mz: 43, intensity: Number.MIN_VALUE * 2, signal_to_noise: null },
      { mz: 44, intensity: Number.MIN_VALUE, signal_to_noise: null },
      { mz: 45, intensity: Number.MAX_VALUE, signal_to_noise: null },
    ]);
    const page = await source.queryTablePage({
      pageIndex: 0,
      pageSize: 10,
      sorting: [{ id: "relativeIntensity", desc: false }],
    });
    expect(page.map((p) => p.id)).toEqual([0, 1, 2]);
    expect(page.map((p) => p.relativeIntensity)).toEqual([0, 0, 100]);
    const tiny = await open([{ mz: 43, intensity: Number.MIN_VALUE, signal_to_noise: 0 }]);
    expect(
      (
        await tiny.queryTablePage({
          pageIndex: 0,
          pageSize: 1,
          sorting: [{ id: "relativeIntensity", desc: true }],
        })
      )[0].relativeIntensity,
    ).toBe(100);
  });

  it("rejects invalid query bounds, unbounded pages, and unsupported sort expressions", async () => {
    const source = await open([{ mz: 43, intensity: 1, signal_to_noise: null }]);
    for (const request of [
      { mzRange: [0, 0] as const, binCount: 10 },
      { mzRange: [-1, 1] as const, binCount: 10 },
      { mzRange: [0, Infinity] as const, binCount: 10 },
      { mzRange: [0, 10] as const, binCount: 0 },
      { mzRange: [0, 10] as const, binCount: 1.5 },
    ])
      await expect(source.queryChart(request)).rejects.toThrow("Chart");
    for (const request of [
      { pageIndex: -1, pageSize: 10, sorting: [] },
      { pageIndex: 0, pageSize: 101, sorting: [] },
      { pageIndex: 0, pageSize: 0, sorting: [] },
      { pageIndex: Number.MAX_SAFE_INTEGER, pageSize: 100, sorting: [] },
      { pageIndex: 0, pageSize: 10, sorting: [{ id: "intensity; DROP TABLE peaks", desc: true }] },
      { pageIndex: 0, pageSize: 10, sorting: [{ id: "__proto__", desc: true }] },
    ])
      await expect(source.queryTablePage(request)).rejects.toThrow(/Table/);
    expect((await source.querySelection()).peakCount).toBe(1);
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

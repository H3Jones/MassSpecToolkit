import { Float64, Table, makeData, makeVector, vectorFromArray } from "apache-arrow";
import type { SpectrumMetadata, SpectrumPeakColumns, SpectrumPeakResult } from "ms-toolkit/core";
import {
  MAX_RENDERED_SPECTRUM_PEAKS,
  normalizeSpectrumPeaks,
  ticBinCount,
  type TicViewportRequest,
  type TicViewportResult,
} from "ms-toolkit/charts";
import { createSpectrumDatabase } from "./duckdb";

export type RetentionTimeRange = readonly [number, number];
export type StoredSpectrumPeak = SpectrumPeakResult & { readonly id: number };
export type MeasuredPeak = Pick<StoredSpectrumPeak, keyof StoredSpectrumPeak> & {
  readonly relativeIntensity: number;
};

export interface SpectrumSelection {
  readonly peakCount: number;
  readonly summary?: {
    readonly minimumMz: number;
    readonly maximumMz: number;
    readonly minimumIntensity: number;
    readonly maximumIntensity: number;
    readonly basePeak: MeasuredPeak;
    readonly basePeakCount: number;
  };
}

export interface SpectrumChartRequest {
  readonly mzRange: readonly [number, number];
  readonly binCount: number;
}

export interface SpectrumChartResult {
  readonly peaks: readonly StoredSpectrumPeak[];
  readonly visibleCount: number;
}

export interface SpectrumTableRequest {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly sorting: readonly { readonly id: string; readonly desc: boolean }[];
}

export interface SpectrumIngestionResult {
  readonly metadata: Readonly<SpectrumMetadata>;
  readonly readMs: number;
  readonly parseMs: number;
}

export type SpectrumIngestor = (
  consume: (batch: SpectrumPeakColumns) => Promise<void>,
) => Promise<SpectrumIngestionResult>;

export interface SpectrumDataSource {
  readonly metadata: Readonly<SpectrumMetadata>;
  readonly timings: {
    readonly readMs: number;
    readonly parseMs: number;
    readonly databaseMs: number;
  };
  querySelection(this: void, range?: RetentionTimeRange): Promise<SpectrumSelection>;
  queryChart(
    this: void,
    request: SpectrumChartRequest,
    range?: RetentionTimeRange,
  ): Promise<SpectrumChartResult>;
  queryTablePage(
    this: void,
    request: SpectrumTableRequest,
    range?: RetentionTimeRange,
  ): Promise<MeasuredPeak[]>;
  queryTic(this: void, request: TicViewportRequest): Promise<TicViewportResult>;
  dispose(): void;
}

const INSERT_BATCH_SIZE = 16_384;

function nullableColumn(values: Float64Array, validity: Uint8Array) {
  const nullBitmap = new Uint8Array(Math.ceil(values.length / 8));
  let nullCount = 0;
  for (let index = 0; index < validity.length; index++) {
    if (validity[index] === 1) nullBitmap[index >> 3] |= 1 << (index & 7);
    else if (validity[index] === 0) nullCount++;
    else throw new Error("Spectrum column validity must contain only zero or one.");
  }
  return makeVector(
    makeData({
      type: new Float64(),
      data: values,
      length: values.length,
      nullBitmap,
      nullCount,
    }),
  );
}

function numberValue(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The spectrum database returned an invalid ${column} value.`);
  }
  return value;
}

function storedPeak(row: Record<string, unknown>): StoredSpectrumPeak {
  const rt = row.retention_time;
  const sn = row.signal_to_noise;
  return {
    id: numberValue(row.id, "row identity"),
    mz: numberValue(row.mz, "m/z"),
    intensity: numberValue(row.intensity, "intensity"),
    signal_to_noise: sn === null ? null : numberValue(sn, "S/N"),
    ...(rt === null ? {} : { retention_time: numberValue(rt, "retention time") }),
  };
}

function measuredPeaks(peaks: readonly StoredSpectrumPeak[], maximum: number): MeasuredPeak[] {
  const normalized = normalizeSpectrumPeaks(
    peaks.map((peak) => ({ mz: peak.mz, int: peak.intensity })),
    maximum,
  );
  return peaks.map((peak, index) => ({
    ...peak,
    relativeIntensity: normalized[index].relativeIntensity,
  }));
}

function chartBins(request: SpectrumChartRequest): number {
  const [minimum, maximum] = request.mzRange;
  if (
    request.mzRange.length !== 2 ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum < 0 ||
    maximum <= minimum ||
    !Number.isFinite(maximum - minimum)
  ) {
    throw new RangeError("Chart m/z bounds must be finite, nonnegative, and increasing.");
  }
  if (!Number.isSafeInteger(request.binCount) || request.binCount < 1) {
    throw new RangeError("Chart bin count must be a positive integer.");
  }
  return Math.min(request.binCount, MAX_RENDERED_SPECTRUM_PEAKS);
}

function tableOrder(request: SpectrumTableRequest, maximum: number): string {
  if (
    !Number.isSafeInteger(request.pageIndex) ||
    request.pageIndex < 0 ||
    !Number.isSafeInteger(request.pageSize) ||
    request.pageSize < 1 ||
    request.pageSize > 100 ||
    !Number.isSafeInteger(request.pageIndex * request.pageSize)
  ) {
    throw new RangeError(
      "Table page index must be nonnegative and page size must be between 1 and 100.",
    );
  }
  const columns: Record<string, string> = {
    id: "id",
    mz: "mz",
    intensity: "intensity",
    relativeIntensity: maximum === 0 ? "(0.0::DOUBLE)" : `((intensity / ${maximum}::DOUBLE) * 100)`,
    signal_to_noise: "signal_to_noise",
    retention_time: "retention_time",
  };
  if (!Array.isArray(request.sorting)) throw new TypeError("Table sorting must be an array.");
  const seen = new Set<string>();
  const order = request.sorting.map((sort) => {
    if (!Object.hasOwn(columns, sort.id) || typeof sort.desc !== "boolean" || seen.has(sort.id)) {
      throw new TypeError(
        "Table sorting must use unique supported measurement columns and boolean directions.",
      );
    }
    seen.add(sort.id);
    return `${columns[sort.id]} ${sort.desc ? "DESC" : "ASC"} NULLS LAST`;
  });
  // Missing values sort last in either direction; ties retain original row identity.
  if (!seen.has("id")) order.push("id ASC");
  return order.join(", ");
}

export function retentionTimePredicate(range?: RetentionTimeRange): string {
  if (!range) return "";
  if (
    range.length !== 2 ||
    !Number.isFinite(range[0]) ||
    !Number.isFinite(range[1]) ||
    range[0] < 0 ||
    range[1] < range[0]
  ) {
    throw new RangeError("RT bounds must be finite, nonnegative, and increasing or equal.");
  }
  // Only validated finite numbers enter SQL; filenames and user strings never do.
  return ` WHERE retention_time BETWEEN ${range[0]} AND ${range[1]}`;
}

/**
 * Full-resolution measurements live in an isolated, in-memory database.
 * RT stays in the original input units. Rows are never merged or intensity-normalized here.
 * The producer awaits each insertion, so only one bounded columnar batch is in flight.
 * Incremental parsing and metadata accumulation run in the Rust worker.
 */
export async function openSpectrumDatabase(
  ingest: SpectrumIngestor,
  signal?: AbortSignal,
): Promise<SpectrumDataSource> {
  const initializationStartedAt = performance.now();
  const database = await createSpectrumDatabase(signal);
  const { connection, run } = database;
  let databaseMs = performance.now() - initializationStartedAt;
  let insertedRows = 0;
  try {
    const schemaStartedAt = performance.now();
    await run(() =>
      connection.query(
        "CREATE TABLE peaks (id DOUBLE, mz DOUBLE, intensity DOUBLE, signal_to_noise DOUBLE, retention_time DOUBLE)",
      ),
    );
    databaseMs += performance.now() - schemaStartedAt;
    const result = await ingest(async (batch) => {
      const batchStartedAt = performance.now();
      const count = batch.mz.length;
      if (count < 1 || count > INSERT_BATCH_SIZE || batch.startIndex !== insertedRows) {
        throw new Error("Spectrum batches must be bounded and retain consecutive row identities.");
      }
      if (
        [
          batch.intensity,
          batch.signalToNoise,
          batch.signalToNoiseValidity,
          batch.retentionTime,
          batch.retentionTimeValidity,
        ].some((column) => column.length !== count)
      ) {
        throw new Error("Spectrum batch columns must have equal lengths.");
      }
      for (let index = 0; index < count; index++) {
        const rt = batch.retentionTime[index];
        if (batch.retentionTimeValidity[index] && (!Number.isFinite(rt) || rt < 0)) {
          throw new RangeError("Retention time must be finite and nonnegative.");
        }
      }
      const table = new Table({
        id: vectorFromArray(Float64Array.from(batch.mz, (_, index) => batch.startIndex + index)),
        mz: vectorFromArray(batch.mz),
        intensity: vectorFromArray(batch.intensity),
        signal_to_noise: nullableColumn(batch.signalToNoise, batch.signalToNoiseValidity),
        retention_time: nullableColumn(batch.retentionTime, batch.retentionTimeValidity),
      });
      await run(() => connection.insertArrowTable(table, { name: "peaks", create: false }));
      insertedRows += count;
      databaseMs += performance.now() - batchStartedAt;
    });
    const { metadata, readMs, parseMs } = result;
    if (!insertedRows) throw new Error("The file contains no peaks.");
    if (metadata.peakCount !== insertedRows) {
      throw new Error("Spectrum metadata does not match the imported peak count.");
    }
    if (
      (metadata.type === "Direct" &&
        (metadata.minimumRetentionTime !== null || metadata.maximumRetentionTime !== null)) ||
      (metadata.type === "Hyphenated" &&
        (metadata.minimumRetentionTime === null || metadata.maximumRetentionTime === null))
    ) {
      throw new Error("Spectrum metadata type and RT bounds are inconsistent.");
    }
    const finalizationStartedAt = performance.now();
    const count = await run(() =>
      connection.query("SELECT count(*)::DOUBLE AS peak_count FROM peaks"),
    );
    if (numberValue(count.get(0)?.peak_count, "peak count") !== insertedRows) {
      throw new Error("The spectrum database did not retain every imported measurement.");
    }
    await run(() =>
      connection.query(`CREATE TABLE SpectrumMetadata (
        filename VARCHAR NOT NULL,
        "type" VARCHAR NOT NULL CHECK ("type" IN ('Direct', 'Hyphenated')),
        peakCount DOUBLE NOT NULL CHECK (peakCount > 0),
        minimumMz DOUBLE NOT NULL CHECK (minimumMz > 0),
        maximumMz DOUBLE NOT NULL CHECK (maximumMz >= minimumMz),
        minimumIntensity DOUBLE NOT NULL CHECK (minimumIntensity >= 0),
        maximumIntensity DOUBLE NOT NULL CHECK (maximumIntensity >= minimumIntensity),
        minimumRetentionTime DOUBLE,
        maximumRetentionTime DOUBLE,
        CHECK (
          ("type" = 'Direct' AND minimumRetentionTime IS NULL AND maximumRetentionTime IS NULL)
          OR ("type" = 'Hyphenated' AND minimumRetentionTime IS NOT NULL
            AND maximumRetentionTime IS NOT NULL AND minimumRetentionTime >= 0
            AND maximumRetentionTime >= minimumRetentionTime)
        )
      )`),
    );
    await run(() =>
      connection.insertArrowTable(
        new Table({
          filename: vectorFromArray([metadata.filename]),
          type: vectorFromArray([metadata.type]),
          peakCount: vectorFromArray([metadata.peakCount], new Float64()),
          minimumMz: vectorFromArray([metadata.minimumMz], new Float64()),
          maximumMz: vectorFromArray([metadata.maximumMz], new Float64()),
          minimumIntensity: vectorFromArray([metadata.minimumIntensity], new Float64()),
          maximumIntensity: vectorFromArray([metadata.maximumIntensity], new Float64()),
          minimumRetentionTime: vectorFromArray([metadata.minimumRetentionTime], new Float64()),
          maximumRetentionTime: vectorFromArray([metadata.maximumRetentionTime], new Float64()),
        }),
        { name: "SpectrumMetadata", create: false },
      ),
    );
    databaseMs += performance.now() - finalizationStartedAt;
    if (metadata.type === "Hyphenated") {
      const ticStartedAt = performance.now();
      await run(() =>
        connection.query(`
        CREATE TABLE tic AS
        SELECT retention_time, sum(intensity)::DOUBLE AS intensity
        FROM peaks WHERE retention_time IS NOT NULL GROUP BY retention_time
      `),
      );
      databaseMs += performance.now() - ticStartedAt;
    }
    let cachedSelection: { predicate: string; pending: Promise<SpectrumSelection> } | undefined;
    async function querySelection(range?: RetentionTimeRange): Promise<SpectrumSelection> {
      const predicate = retentionTimePredicate(range);
      return run(() => {
        if (cachedSelection?.predicate === predicate) return cachedSelection.pending;
        const pending: Promise<SpectrumSelection> = (async () => {
          const result = await run(() =>
            connection.query(`
            WITH stats AS (
              SELECT count(*)::DOUBLE AS peak_count, min(mz) AS minimum_mz,
                max(mz) AS maximum_mz, min(intensity) AS minimum_intensity,
                max(intensity) AS maximum_intensity FROM peaks${predicate}
            )
            SELECT stats.*, base.*,
              (SELECT count(*)::DOUBLE FROM peaks${predicate || " WHERE TRUE"}
                AND intensity = stats.maximum_intensity) AS base_peak_count
            FROM stats LEFT JOIN
              (SELECT * FROM peaks${predicate} ORDER BY intensity DESC, id ASC LIMIT 1) base
            ON TRUE
          `),
          );
          const row = result.get(0);
          if (!row) throw new Error("The spectrum database did not return selection statistics.");
          const peakCount = numberValue(row.peak_count, "peak count");
          if (peakCount === 0) return { peakCount };
          const maximumIntensity = numberValue(row.maximum_intensity, "maximum intensity");
          return {
            peakCount,
            summary: {
              minimumMz: numberValue(row.minimum_mz, "minimum m/z"),
              maximumMz: numberValue(row.maximum_mz, "maximum m/z"),
              minimumIntensity: numberValue(row.minimum_intensity, "minimum intensity"),
              maximumIntensity,
              basePeak: measuredPeaks([storedPeak(row)], maximumIntensity)[0],
              basePeakCount: numberValue(row.base_peak_count, "base peak count"),
            },
          };
        })().catch((error: unknown) => {
          if (cachedSelection?.pending === pending) cachedSelection = undefined;
          throw error;
        });
        cachedSelection = { predicate, pending };
        return pending;
      });
    }
    return {
      metadata,
      timings: { readMs, parseMs, databaseMs },
      querySelection,
      async queryTic(request) {
        const bins = ticBinCount(request);
        if (metadata.type === "Direct") return run(async () => ({ points: [], visibleCount: 0 }));
        const [minimum, maximum] = request.rtRange;
        const bin =
          minimum === maximum
            ? "(retention_time * 0)"
            : `least(${bins - 1},
          floor(((retention_time - ${minimum}::DOUBLE) / ${maximum - minimum}::DOUBLE) * ${bins}))`;
        const result = await run(() =>
          connection.query(`
          WITH bins AS (
            SELECT arg_min(
              struct_pack(retention_time := retention_time, intensity := intensity),
              struct_pack(strength := -intensity, rt := retention_time)
            ) AS winner, count(*)::DOUBLE AS bin_count
            FROM tic WHERE retention_time BETWEEN ${minimum}::DOUBLE AND ${maximum}::DOUBLE
            GROUP BY ${bin}
          )
          SELECT winner.retention_time AS retention_time, winner.intensity AS intensity,
            sum(bin_count) OVER ()::DOUBLE AS visible_count
          FROM bins ORDER BY winner.retention_time
        `),
        );
        if (result.numRows > bins) throw new Error("The TIC query exceeded its bin budget.");
        return {
          points: Array.from(result, (row) => ({
            retentionTime: numberValue(row.retention_time, "TIC retention time"),
            intensity: numberValue(row.intensity, "total ion intensity"),
          })),
          visibleCount: result.numRows
            ? numberValue(result.get(0)?.visible_count, "TIC scan count")
            : 0,
        };
      },
      async queryChart(request, range) {
        const bins = chartBins(request);
        const [minimum, maximum] = request.mzRange;
        const predicate = retentionTimePredicate(range);
        const result = await run(() =>
          connection.query(`
          WITH bins AS (
            SELECT arg_min(
              struct_pack(id := id, mz := mz, intensity := intensity,
                signal_to_noise := signal_to_noise, retention_time := retention_time),
              struct_pack(strength := -intensity, identity := id)
            ) AS winner, count(*)::DOUBLE AS bin_count
            FROM peaks${predicate || " WHERE TRUE"}
              AND mz BETWEEN ${minimum}::DOUBLE AND ${maximum}::DOUBLE
            GROUP BY least(${bins - 1},
              floor(((mz - ${minimum}::DOUBLE) / ${maximum - minimum}::DOUBLE) * ${bins}))
          )
          SELECT winner.id AS id, winner.mz AS mz, winner.intensity AS intensity,
            winner.signal_to_noise AS signal_to_noise, winner.retention_time AS retention_time,
            sum(bin_count) OVER ()::DOUBLE AS visible_count FROM bins ORDER BY winner.id
        `),
        );
        if (result.numRows > bins) throw new Error("The chart query exceeded its bin budget.");
        return {
          peaks: Array.from(result, storedPeak),
          visibleCount: result.numRows
            ? numberValue(result.get(0)?.visible_count, "visible count")
            : 0,
        };
      },
      async queryTablePage(request, range) {
        const selection = await querySelection(range);
        const maximum = selection.summary?.maximumIntensity ?? 0;
        const order = tableOrder(request, maximum);
        const predicate = retentionTimePredicate(range);
        const result = await run(() =>
          connection.query(
            `SELECT * FROM peaks${predicate} ORDER BY ${order} LIMIT ${request.pageSize}
            OFFSET ${request.pageIndex * request.pageSize}`,
          ),
        );
        if (result.numRows > request.pageSize)
          throw new Error("The table query exceeded its page size.");
        return measuredPeaks(Array.from(result, storedPeak), maximum);
      },
      dispose: database.dispose,
    };
  } catch (error) {
    database.dispose();
    throw error;
  }
}

import { Float64, Table, makeData, makeVector, vectorFromArray } from "apache-arrow";
import type { SpectrumMetadata, SpectrumPeakColumns, SpectrumPeakResult } from "ms-toolkit/core";
import { createSpectrumDatabase } from "./duckdb";

export type RetentionTimeRange = readonly [number, number];
export type StoredSpectrumPeak = SpectrumPeakResult & { readonly id: number };

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
  queryPeaks(range?: RetentionTimeRange): Promise<StoredSpectrumPeak[]>;
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
 * Parsing still materializes the input in the Rust worker.
 */
export async function openSpectrumDatabase(ingest: SpectrumIngestor): Promise<SpectrumDataSource> {
  const initializationStartedAt = performance.now();
  const database = await createSpectrumDatabase();
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
    return {
      metadata,
      timings: { readMs, parseMs, databaseMs },
      async queryPeaks(range) {
        const predicate = retentionTimePredicate(range);
        const result = await run(() =>
          connection.query(`SELECT * FROM peaks${predicate} ORDER BY id`),
        );
        const rows: StoredSpectrumPeak[] = [];
        for (const row of result) {
          const rt: unknown = row.retention_time;
          const sn: unknown = row.signal_to_noise;
          rows.push({
            id: numberValue(row.id, "row identity"),
            mz: numberValue(row.mz, "m/z"),
            intensity: numberValue(row.intensity, "intensity"),
            signal_to_noise: sn === null ? null : numberValue(sn, "S/N"),
            ...(rt === null ? {} : { retention_time: numberValue(rt, "retention time") }),
          });
        }
        return rows;
      },
      dispose: database.dispose,
    };
  } catch (error) {
    database.dispose();
    throw error;
  }
}

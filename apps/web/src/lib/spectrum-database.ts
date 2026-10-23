import { Float64, Table, vectorFromArray } from "apache-arrow";
import type { SpectrumMetadata, SpectrumPeakResult } from "ms-toolkit/core";

export type RetentionTimeRange = readonly [number, number];
export type StoredSpectrumPeak = SpectrumPeakResult & { readonly id: number };

export interface SpectrumDataSource {
  readonly metadata: Readonly<SpectrumMetadata>;
  queryPeaks(range?: RetentionTimeRange): Promise<StoredSpectrumPeak[]>;
  dispose(): void;
}

const INSERT_BATCH_SIZE = 16_384;

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
 * Arrow bounds each insertion batch; parsing still materializes the input in the Rust worker.
 */
export async function openSpectrumDatabase(
  peaks: readonly SpectrumPeakResult[],
  metadata: Readonly<SpectrumMetadata>,
): Promise<SpectrumDataSource> {
  if (!peaks.length) throw new Error("The file contains no peaks.");
  if (metadata.peakCount !== peaks.length) {
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
  const { createSpectrumDatabase } = await import("./duckdb");
  const database = await createSpectrumDatabase();
  const { connection, run } = database;
  try {
    await run(() =>
      connection.query(
        "CREATE TABLE peaks (id DOUBLE, mz DOUBLE, intensity DOUBLE, signal_to_noise DOUBLE, retention_time DOUBLE)",
      ),
    );
    for (let offset = 0; offset < peaks.length; offset += INSERT_BATCH_SIZE) {
      const batch = peaks.slice(offset, offset + INSERT_BATCH_SIZE);
      const retentionTimes = batch.map((peak) => {
        const rt = peak.retention_time;
        if (rt === undefined) return null;
        if (!Number.isFinite(rt) || rt < 0) {
          throw new RangeError("Retention time must be finite and nonnegative.");
        }
        return rt;
      });
      const table = new Table({
        id: vectorFromArray(Float64Array.from(batch, (_, index) => offset + index)),
        mz: vectorFromArray(Float64Array.from(batch, (peak) => peak.mz)),
        intensity: vectorFromArray(Float64Array.from(batch, (peak) => peak.intensity)),
        signal_to_noise: vectorFromArray(
          batch.map((peak) => peak.signal_to_noise),
          new Float64(),
        ),
        retention_time: vectorFromArray(retentionTimes, new Float64()),
      });
      await run(() => connection.insertArrowTable(table, { name: "peaks", create: false }));
    }
    const count = await run(() =>
      connection.query("SELECT count(*)::DOUBLE AS peak_count FROM peaks"),
    );
    if (numberValue(count.get(0)?.peak_count, "peak count") !== peaks.length) {
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
    return {
      metadata,
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

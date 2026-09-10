import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Ohlcv } from "@tao-tools/core";
import { resolveBronzeUri as resolveDefaultBronzeUri } from "../paths.js";
import { configureR2Secret } from "./r2Secret.js";

export interface WriteBronzeOptions {
  rows: readonly Ohlcv[];
  exchange: string;
  pair: string;
  /** yyyy-mm bucket, e.g. "2026-08" — matches the layout in §2. */
  month: string;
  /** Defaults to env BRONZE_URI, then "./data/bronze" (local stand-in for R2). */
  bronzeUri?: string;
}

export interface WriteBronzeResult {
  destination: string;
  /** Rows in the file after this write — may exceed `opts.rows.length` when
   * merged with what a previous run already wrote for this month. */
  rowCount: number;
}

/** Bronze columns are snake_case, matching every other layer (§2 layout). */
function toSnakeCaseRow(row: Ohlcv): Record<string, unknown> {
  return {
    exchange: row.exchange,
    pair: row.pair,
    timestamp_ms: row.timestampMs,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    base_volume: row.baseVolume,
    quote_volume: row.quoteVolume,
    is_partial: row.isPartial,
  };
}

function resolveBronzeUri(explicit: string | undefined): string {
  const uri = explicit ?? resolveDefaultBronzeUri();
  return uri.replace(/\\/g, "/").replace(/\/+$/, "");
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Writes one venue/month's candles to bronze, **merged with whatever's
 * already there for that month, deduplicated by `timestamp_ms`** — not a
 * plain overwrite. `runResumableVenueBackfill` (`exchanges/backfill.ts`)
 * only ever buffers rows fetched *during the current run*, so the month
 * containing "now" gets revisited and re-flushed across every future
 * resumed run (it's never "closed" the way an earlier month is). A plain
 * overwrite there would silently discard everything an earlier run had
 * already written, keeping only the latest increment.
 *
 * Found for real (2026-09-10): after a second backfill run, every venue's
 * current-month bronze file had shrunk to a few KB (just that run's new
 * rows) instead of the hundreds of KB a real month's worth of 1-minute
 * candles should be — binance's `2026-09.parquet` went from what should
 * have been ~800KB down to 2.3KB. A month that's genuinely new (no file yet)
 * is unaffected by this — merging with nothing is the same as overwriting.
 */
export async function writeOhlcBronze(opts: WriteBronzeOptions): Promise<WriteBronzeResult> {
  const bronzeUri = resolveBronzeUri(opts.bronzeUri);
  const destination = `${bronzeUri}/prices/${opts.exchange}/${opts.pair}/${opts.month}.parquet`;
  const isRemote = destination.startsWith("s3://");

  if (!isRemote) {
    mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
  }

  const stagingFile = join(tmpdir(), `tao-price-bronze-stage-${randomUUID()}.ndjson`);
  const tempDestination = `${destination}.tmp-${randomUUID()}`;
  try {
    const ndjson = opts.rows
      .map((row) => JSON.stringify(toSnakeCaseRow(row)))
      .join("\n");
    writeFileSync(stagingFile, ndjson, "utf-8");

    let rowCount: number;
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      if (isRemote) await configureR2Secret(connection);

      await connection.run(
        `CREATE OR REPLACE TABLE new_rows AS SELECT * FROM read_json_auto('${escapeSqlLiteral(stagingFile)}');`,
      );

      let existingFileFound = true;
      if (!isRemote) {
        existingFileFound = existsSync(destination);
      }
      let hasExisting = false;
      if (existingFileFound) {
        try {
          await connection.run(
            `CREATE OR REPLACE TABLE existing_rows AS SELECT * FROM read_parquet('${escapeSqlLiteral(destination)}');`,
          );
          hasExisting = true;
        } catch {
          hasExisting = false; // no file there yet (first write for this month)
        }
      }

      // NOT EXISTS rather than NOT IN — NOT IN against a subquery is
      // NULL-unsafe (any null in the subquery makes every row false), a
      // trap not worth relying on `timestamp_ms` never being null to avoid.
      const combined = hasExisting
        ? `SELECT * FROM new_rows
           UNION ALL
           SELECT existing_rows.* FROM existing_rows
           WHERE NOT EXISTS (SELECT 1 FROM new_rows WHERE new_rows.timestamp_ms = existing_rows.timestamp_ms)`
        : `SELECT * FROM new_rows`;

      await connection.run(
        `COPY (SELECT * FROM (${combined}) ORDER BY timestamp_ms) TO '${escapeSqlLiteral(tempDestination)}' ` +
          `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000);`,
      );
      const countResult = await connection.run(`SELECT COUNT(*) FROM read_parquet('${escapeSqlLiteral(tempDestination)}');`);
      rowCount = Number((await countResult.getRows())[0]![0]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    renameSync(tempDestination, destination);
    return { destination, rowCount };
  } finally {
    rmSync(stagingFile, { force: true });
    rmSync(tempDestination, { force: true });
  }
}

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Ohlcv } from "@tao-tools/core";
import { resolveBronzeUri as resolveDefaultBronzeUri } from "../paths.js";

/**
 * Bronze is written exclusively by DuckDB COPY (tao-analytics-plan.md §2,
 * "DuckDB is the only Parquet writer"). This module never encodes Parquet
 * itself — it stages rows as NDJSON, loads that into a DuckDB table via
 * read_json_auto, and lets DuckDB do the COPY. Works identically against a
 * local path or an s3:// URI: only the destination string and whether an R2
 * secret is configured change.
 */

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
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
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

async function configureR2Secret(connection: {
  run: (sql: string) => Promise<unknown>;
}): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const keyId = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !keyId || !secret) {
    throw new Error(
      "BRONZE_URI points at s3:// but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are not set. " +
        "See .env.example.",
    );
  }
  await connection.run("INSTALL httpfs; LOAD httpfs;");
  await connection.run(
    `CREATE OR REPLACE SECRET r2_secret (
       TYPE R2,
       KEY_ID '${escapeSqlLiteral(keyId)}',
       SECRET '${escapeSqlLiteral(secret)}',
       ACCOUNT_ID '${escapeSqlLiteral(accountId)}'
     );`,
  );
}

export async function writeOhlcBronze(opts: WriteBronzeOptions): Promise<WriteBronzeResult> {
  const bronzeUri = resolveBronzeUri(opts.bronzeUri);
  const destination = `${bronzeUri}/prices/${opts.exchange}/${opts.pair}/${opts.month}.parquet`;
  const isRemote = destination.startsWith("s3://");

  if (!isRemote) {
    mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
  }

  const stagingFile = join(tmpdir(), `tao-bronze-stage-${randomUUID()}.ndjson`);
  const ndjson = opts.rows.map((row) => JSON.stringify(toSnakeCaseRow(row))).join("\n");
  writeFileSync(stagingFile, ndjson, "utf-8");

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    if (isRemote) {
      await configureR2Secret(connection);
    }

    await connection.run(
      `CREATE OR REPLACE TABLE staged AS SELECT * FROM read_json_auto('${escapeSqlLiteral(stagingFile)}');`,
    );
    await connection.run(
      `COPY (SELECT * FROM staged) TO '${escapeSqlLiteral(destination)}' ` +
        `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000);`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
    rmSync(stagingFile, { force: true });
  }

  return { destination, rowCount: opts.rows.length };
}

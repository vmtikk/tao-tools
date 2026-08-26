import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { configureR2Secret } from "./r2Secret.js";

/**
 * The one place that stages rows -> NDJSON -> DuckDB table -> `COPY ... TO
 * parquet` (tao-analytics-plan.md §2, "DuckDB is the only Parquet writer").
 * Every bronze writer (prices, chain events, chain metadata) is a thin
 * wrapper around this that only supplies the row shape and destination path.
 * Works identically against a local path or an `s3://` URI. Also reused by
 * `pipeline`'s chain silver materialization (decoded rows still need this
 * same JS-object -> Parquet staging step; silver just never points it at
 * `s3://`) rather than duplicating the staging boilerplate a third time.
 */

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export interface WriteRowsAsParquetOptions {
  rows: readonly Record<string, unknown>[];
  /** Full path or `s3://...` URI, including filename. */
  destination: string;
}

export interface WriteRowsAsParquetResult {
  destination: string;
  rowCount: number;
}

export async function writeRowsAsParquet(opts: WriteRowsAsParquetOptions): Promise<WriteRowsAsParquetResult> {
  const destination = opts.destination.replace(/\\/g, "/");
  const isRemote = destination.startsWith("s3://");

  if (!isRemote) {
    mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
  }

  const stagingFile = join(tmpdir(), `tao-bronze-stage-${randomUUID()}.ndjson`);
  const ndjson = opts.rows
    .map((row) => JSON.stringify(row, (_key, value) => (typeof value === "bigint" ? value.toString() : value)))
    .join("\n");
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

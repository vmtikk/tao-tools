import { createWriteStream, mkdirSync, rmSync } from "node:fs";
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

/**
 * Writes rows to `path` as newline-delimited JSON, one `stream.write()` per
 * row rather than building the whole NDJSON payload as a single JS string
 * first. That in-memory-string approach (`rows.map(...).join("\n")`) is what
 * this replaced — it hit `RangeError: Invalid string length` on a real
 * 20,001-block chain-events bronze write (2026-08-26, tao-analytics-plan.md
 * §6, Phase 2.3 sample): `events_hex` blobs vary a lot in size across
 * blocks, and this particular real range's combined NDJSON exceeded V8's
 * ~512MB-1GB single-string ceiling well before hitting any row-count limit
 * that would look dangerous in a smaller test. Streaming avoids the ceiling
 * entirely — no step here ever holds more than one row's JSON plus whatever
 * is still in the OS write buffer.
 */
function writeNdjsonStreaming(path: string, rows: readonly Record<string, unknown>[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createWriteStream(path, { encoding: "utf-8" });
    stream.on("error", reject);
    stream.on("finish", resolve);

    let index = 0;
    const writeNext = (): void => {
      let canWriteMore = true;
      while (index < rows.length && canWriteMore) {
        const line = JSON.stringify(rows[index], (_key, value) => (typeof value === "bigint" ? value.toString() : value));
        canWriteMore = stream.write(index === rows.length - 1 ? line : `${line}\n`);
        index++;
      }
      if (index < rows.length) {
        stream.once("drain", writeNext);
      } else {
        stream.end();
      }
    };
    writeNext();
  });
}

export async function writeRowsAsParquet(opts: WriteRowsAsParquetOptions): Promise<WriteRowsAsParquetResult> {
  const destination = opts.destination.replace(/\\/g, "/");
  const isRemote = destination.startsWith("s3://");

  if (!isRemote) {
    mkdirSync(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
  }

  const stagingFile = join(tmpdir(), `tao-bronze-stage-${randomUUID()}.ndjson`);
  try {
    await writeNdjsonStreaming(stagingFile, opts.rows);

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
    }
  } finally {
    // Covers a failure in the streaming write itself (e.g. the real ENOSPC
    // hit during a 2026-08-26 Phase 2.3 sample, plan §6) as well as the
    // DuckDB step — previously this cleanup only wrapped the DuckDB half, so
    // a write failure left a partial (sometimes very large) staging file
    // behind permanently.
    rmSync(stagingFile, { force: true });
  }

  return { destination, rowCount: opts.rows.length };
}

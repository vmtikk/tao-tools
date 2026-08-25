import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import type { GapRange, UnixMillis } from "@tao-tools/core";
import { metaDir } from "../paths.js";

/**
 * One row of /data/meta/ingestion_log.parquet (tao-analytics-plan.md §2,
 * §10: "Silent poller death leaves gaps found months later"). A clean run
 * with no gaps still gets one row, with gapStartMs/gapEndMs null — so the
 * absence of a run is distinguishable from a run that found nothing wrong.
 */
export interface IngestionLogEntry {
  exchange: string;
  pair: string;
  runAtMs: UnixMillis;
  rowsFetched: number;
  gapStartMs: UnixMillis | null;
  gapEndMs: UnixMillis | null;
  missingBuckets: number;
}

/** Turns a backfill run's gap findings into log rows — one per gap, or a
 * single clean-run row when there were none. Pure, so the "what do we log"
 * decision is testable without touching a DuckDB file. */
export function gapsToLogEntries(
  exchange: string,
  pair: string,
  runAtMs: UnixMillis,
  rowsFetched: number,
  gaps: readonly GapRange[],
): IngestionLogEntry[] {
  if (gaps.length === 0) {
    return [{ exchange, pair, runAtMs, rowsFetched, gapStartMs: null, gapEndMs: null, missingBuckets: 0 }];
  }
  return gaps.map((gap) => ({
    exchange,
    pair,
    runAtMs,
    rowsFetched,
    gapStartMs: gap.startMs,
    gapEndMs: gap.endMs,
    missingBuckets: gap.missingBuckets,
  }));
}

export interface AppendIngestionLogResult {
  destination: string;
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function toSnakeCaseRow(entry: IngestionLogEntry): Record<string, unknown> {
  return {
    exchange: entry.exchange,
    pair: entry.pair,
    run_at_ms: entry.runAtMs,
    rows_fetched: entry.rowsFetched,
    gap_start_ms: entry.gapStartMs,
    gap_end_ms: entry.gapEndMs,
    missing_buckets: entry.missingBuckets,
  };
}

/**
 * Appends rows to the local ingestion log (never on R2 — §2's layout places
 * this under local /data/meta, not bronze). Parquet has no native append, so
 * this reads whatever is already there, unions it with the new rows, and
 * writes the result to a temp file before atomically replacing the
 * destination — never a partial file if the process dies mid-write.
 */
export async function appendIngestionLog(entries: readonly IngestionLogEntry[]): Promise<AppendIngestionLogResult> {
  const destination = `${metaDir()}/ingestion_log.parquet`;
  if (entries.length === 0) {
    return { destination, rowCount: 0 };
  }

  mkdirSync(metaDir(), { recursive: true });

  const stagingFile = join(tmpdir(), `tao-ingestion-log-stage-${randomUUID()}.ndjson`);
  const ndjson = entries.map((e) => JSON.stringify(toSnakeCaseRow(e))).join("\n");
  writeFileSync(stagingFile, ndjson, "utf-8");

  const tempDestination = `${destination}.tmp-${randomUUID()}`;
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run(
      `CREATE OR REPLACE TABLE new_entries AS SELECT * FROM read_json_auto('${escapeSqlLiteral(stagingFile)}');`,
    );
    const combined = existsSync(destination)
      ? `SELECT * FROM read_parquet('${escapeSqlLiteral(destination)}') UNION ALL SELECT * FROM new_entries`
      : `SELECT * FROM new_entries`;
    await connection.run(
      `COPY (${combined}) TO '${escapeSqlLiteral(tempDestination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    );
    const result = await connection.run(`SELECT COUNT(*) AS n FROM (${combined}) t;`);
    const rows = await result.getRows();
    const rowCount = Number(rows[0]?.[0] ?? 0);

    connection.closeSync();
    instance.closeSync();
    renameSync(tempDestination, destination);

    return { destination, rowCount };
  } finally {
    rmSync(stagingFile, { force: true });
    rmSync(tempDestination, { force: true });
  }
}

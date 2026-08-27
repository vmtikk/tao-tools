import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import type { RuntimeSegment } from "./detectRuntimeUpgrades.js";
import { metaDir } from "../paths.js";

/**
 * `/meta/runtime_versions.parquet` (tao-analytics-plan.md §2 layout) — one
 * row per runtime segment discovered by `detectRuntimeSegments` during the
 * Phase 2.3 backfill. This is the audit trail for "every row's spec_version
 * reflects the runtime actually active at that block" (§6, Phase 2.3's Done
 * When): it records which block ranges the backfill *believed* belonged to
 * which spec_version, independent of the bronze events files themselves, so
 * a later discrepancy can be traced to a specific detection run.
 *
 * Appends, same atomic read-union-write-rename pattern as
 * `log/ingestionLog.ts` — Parquet has no native append.
 */

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function destinationPath(): string {
  return `${metaDir()}/runtime_versions.parquet`;
}

export interface AppendRuntimeVersionsResult {
  destination: string;
  rowCount: number;
}

export async function appendRuntimeVersions(
  segments: readonly RuntimeSegment[],
): Promise<AppendRuntimeVersionsResult> {
  const destination = destinationPath();
  if (segments.length === 0) {
    return { destination, rowCount: 0 };
  }

  mkdirSync(metaDir(), { recursive: true });

  const stagingFile = join(tmpdir(), `tao-runtime-versions-stage-${randomUUID()}.ndjson`);
  const ndjson = segments
    .map((s) =>
      JSON.stringify({ from_block: s.fromBlock, to_block: s.toBlock, spec_version: s.specVersion }),
    )
    .join("\n");
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

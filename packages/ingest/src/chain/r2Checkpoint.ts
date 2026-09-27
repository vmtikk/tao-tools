import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DuckDBInstance } from "@duckdb/node-api";
import { configureR2Secret } from "../bronze/r2Secret.js";
import { resolveBronzeUri } from "../paths.js";
import { readRawCheckpoint, type BackfillCheckpoint } from "./backfillCheckpoint.js";

/**
 * Once bronze itself lives in R2, the resume checkpoint moves there too —
 * same bucket, next to `chain/events` and `chain/metadata` (plan §2 layout).
 * That makes R2 the one shared source of truth: any machine running
 * `chain:backfill`/`sync-bronze.sh` (laptop today, a VPS tomorrow) resumes
 * from the same state without anyone `scp`-ing a checkpoint file around —
 * switching which machine runs the sync becomes a `git pull`, not a file copy.
 *
 * Local dev (BRONZE_URI left as a local path, `.env.example`'s default)
 * keeps using `backfillCheckpoint.ts`'s plain-fs checkpoint — there's nothing
 * to share with anyone in that mode, and no R2 credentials to require.
 *
 * No compare-and-swap here (no ETag/If-Match) — last write wins. That's
 * deliberate, not an oversight: this codebase's existing rule is "never run
 * `sync-bronze.sh`/`chain:backfill` on two machines at once" (see
 * sync-bronze.sh's header comment and the README), and bronze filenames are
 * deterministic and idempotent, so the worst case of a rule violation is
 * redundant reprocessing of an already-completed range, not lost or
 * corrupted data. Adding real CAS would mean a second way to talk to R2
 * (the AWS SDK, since DuckDB's `COPY`/`read_json_auto` over httpfs has no
 * conditional-write option) for a race this codebase already forbids by
 * convention.
 */

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function checkpointUri(): string {
  return `${resolveBronzeUri().replace(/\/+$/, "")}/chain/meta/backfill_checkpoint.json`;
}

export function isRemoteBronze(): boolean {
  return resolveBronzeUri().startsWith("s3://");
}

/**
 * Raw read, unfiltered by range — same contract as
 * `backfillCheckpoint.ts`'s `readRawCheckpoint`, just against R2. A missing
 * object (first run ever, or first run against a fresh bucket) is not an
 * error: DuckDB throws on a 404 the same way `checkPriceCoverage.ts` sees a
 * "no bronze files found" error for a venue that hasn't backfilled yet, and
 * that's treated the same way here — as "nothing yet," not a failure.
 */
export async function readCheckpointFromR2(): Promise<BackfillCheckpoint | null> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await configureR2Secret(connection);
    const result = await connection.run(
      `SELECT fromBlock, toBlock, lastCompletedBlock, updatedAtMs ` +
        `FROM read_json_auto('${escapeSqlLiteral(checkpointUri())}');`,
    );
    const rows = await result.getRows();
    if (rows.length === 0) return null;
    const [fromBlock, toBlock, lastCompletedBlock, updatedAtMs] = rows[0]!;
    return {
      fromBlock: Number(fromBlock),
      toBlock: Number(toBlock),
      lastCompletedBlock: Number(lastCompletedBlock),
      updatedAtMs: Number(updatedAtMs),
    };
  } catch {
    return null;
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export async function writeCheckpointToR2(checkpoint: BackfillCheckpoint): Promise<void> {
  const stagingFile = join(tmpdir(), `tao-checkpoint-stage-${randomUUID()}.ndjson`);
  writeFileSync(stagingFile, JSON.stringify(checkpoint), "utf-8");

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await configureR2Secret(connection);
    await connection.run(
      `CREATE OR REPLACE TABLE staged AS SELECT * FROM read_json_auto('${escapeSqlLiteral(stagingFile)}');`,
    );
    await connection.run(
      `COPY (SELECT * FROM staged) TO '${escapeSqlLiteral(checkpointUri())}' (FORMAT JSON, ARRAY false);`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
    rmSync(stagingFile, { force: true });
  }
}

/** Whatever checkpoint is current, regardless of backend — the one function
 * `chain:next-from-block` (and anything else that just wants "where did the
 * last run leave off") needs to call. */
export async function readEffectiveCheckpoint(): Promise<BackfillCheckpoint | null> {
  return isRemoteBronze() ? readCheckpointFromR2() : readRawCheckpoint();
}

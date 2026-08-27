import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { metaDir } from "../paths.js";

/**
 * Resumability for the Phase 2.3 full backfill (tao-analytics-plan.md §6:
 * "the one expensive step... resumable and checkpointed"). A ~25-hour,
 * paid-RU run against Pro must not restart from genesis after a crash or a
 * deliberate stop. Written after each chunk is durably in bronze, so a
 * restart resumes from `lastCompletedBlock + 1` rather than redoing work.
 *
 * Local JSON, not Parquet — this is a single scalar checkpoint, not a table
 * (see `log/runtimeVersionsLog.ts` for the equivalent audit trail, which is
 * append-only and does belong in Parquet).
 */
export interface BackfillCheckpoint {
  fromBlock: number;
  toBlock: number;
  lastCompletedBlock: number;
  updatedAtMs: number;
}

function checkpointPath(): string {
  return `${metaDir()}/chain_backfill_checkpoint.json`;
}

/**
 * Only returns a checkpoint that matches the exact [fromBlock, toBlock] the
 * caller is running — a checkpoint left over from a different range (a test
 * window, an earlier partial plan) must not silently redirect this run.
 */
export function readCheckpoint(fromBlock: number, toBlock: number): BackfillCheckpoint | null {
  const path = checkpointPath();
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as BackfillCheckpoint;
  if (parsed.fromBlock !== fromBlock || parsed.toBlock !== toBlock) return null;
  return parsed;
}

/**
 * Looks up only the `toBlock` a previous run pinned for this `fromBlock`,
 * ignoring whatever `toBlock` (if any) the caller has in mind. Exists so
 * `backfillChainEvents.ts` can resolve "current chain head" exactly once —
 * on the very first run — rather than on every restart: the head moves
 * every ~12s, so re-resolving it on each restart would produce a `toBlock`
 * that never matches the checkpoint's, silently defeating resumption and
 * restarting the whole range from `fromBlock`.
 */
export function readCheckpointToBlock(fromBlock: number): number | null {
  const path = checkpointPath();
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as BackfillCheckpoint;
  if (parsed.fromBlock !== fromBlock) return null;
  return parsed.toBlock;
}

export function writeCheckpoint(checkpoint: BackfillCheckpoint): void {
  mkdirSync(metaDir(), { recursive: true });
  const path = checkpointPath();
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), "utf-8");
  renameSync(tempPath, path);
}

export function clearCheckpoint(): void {
  rmSync(checkpointPath(), { force: true });
}

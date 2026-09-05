import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { metaDir } from "../paths.js";

/**
 * Resumability for `chain:materialize-silver` (mirrors
 * `@tao-tools/ingest`'s `backfillCheckpoint.ts` for the same reason: decoding
 * the full range is hours of local CPU work, and a machine that can't stay
 * on that long must be able to stop and resume without redoing already-
 * decoded blocks).
 *
 * Keyed on `fromBlock` only, not `toBlock` — unlike the chain backfill's
 * checkpoint, `toBlock` here is expected to grow between runs (it tracks
 * however far bronze currently reaches, per tao-analytics-plan.md §6's
 * "re-run with a larger UP_TO_BLOCK as the backfill progresses"), so an
 * exact-range match would wrongly refuse to resume every time more bronze
 * shows up.
 */
export interface MaterializeSilverCheckpoint {
  fromBlock: number;
  lastCompletedBatchEnd: number;
  updatedAtMs: number;
}

function checkpointPath(): string {
  return `${metaDir()}/chain_materialize_silver_checkpoint.json`;
}

export function readMaterializeSilverCheckpoint(fromBlock: number): MaterializeSilverCheckpoint | null {
  const path = checkpointPath();
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as MaterializeSilverCheckpoint;
  if (parsed.fromBlock !== fromBlock) return null;
  return parsed;
}

export function writeMaterializeSilverCheckpoint(checkpoint: MaterializeSilverCheckpoint): void {
  mkdirSync(metaDir(), { recursive: true });
  const path = checkpointPath();
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), "utf-8");
  renameSync(tempPath, path);
}

export function clearMaterializeSilverCheckpoint(): void {
  rmSync(checkpointPath(), { force: true });
}

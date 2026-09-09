import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { metaDir } from "../paths.js";

/**
 * Resumability for sharded gold metrics (see MetricEntrySchema's `shard_by`).
 * Mirrors chain/materializeSilverCheckpoint.ts: the work is hours of local
 * compute, so a machine that can't stay on that long has to stop and continue
 * without redoing finished shards.
 *
 * `fingerprint` covers both the inputs (silver parquet sizes/mtimes) and the
 * metric definition itself, so a checkpoint is only ever resumed against the
 * exact inputs and SQL that produced its parts. Editing the metric's SQL
 * mid-run, or re-materializing silver underneath it, invalidates the
 * checkpoint rather than blending two generations of data into one output.
 */
export interface GoldShardCheckpoint {
  metric: string;
  shardCount: number;
  fingerprint: string;
  completedShards: number[];
  updatedAtMs: number;
}

function checkpointPath(metric: string): string {
  return `${metaDir()}/gold_shard_checkpoint_${metric}.json`;
}

export function readGoldShardCheckpoint(metric: string): GoldShardCheckpoint | null {
  const path = checkpointPath(metric);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GoldShardCheckpoint;
  } catch (err) {
    // Found for real (2026-09-08, on materializeSilverCheckpoint's equivalent):
    // a hard power-off left the checkpoint file the right length but filled
    // with NUL bytes — the rename had landed while the written bytes hadn't
    // been flushed. That file parses as neither JSON nor nothing, and the
    // reader there threw, which would abort a run that is otherwise perfectly
    // able to continue. An unreadable checkpoint means exactly one thing —
    // we don't know what's done — so treat it as "no checkpoint" and redo the
    // shards rather than failing outright.
    console.warn(
      `readGoldShardCheckpoint: ignoring unreadable checkpoint at ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}) — restarting this metric's shards.`,
    );
    return null;
  }
}

export function writeGoldShardCheckpoint(checkpoint: GoldShardCheckpoint): void {
  mkdirSync(metaDir(), { recursive: true });
  const path = checkpointPath(checkpoint.metric);
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), "utf-8");
  renameSync(tempPath, path);
}

export function clearGoldShardCheckpoint(metric: string): void {
  rmSync(checkpointPath(metric), { force: true });
}

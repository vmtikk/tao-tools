import { appendFileSync, mkdirSync } from "node:fs";
import { metaDir } from "../paths.js";

/**
 * `/meta/materialize_silver_skipped_blocks.jsonl` — append-only audit trail
 * for blocks `materializeChainSilver` couldn't decode and skipped rather
 * than let crash the whole run. One bad block out of ~9M must not block the
 * rest from decoding; it must also not vanish silently, hence this log
 * rather than a bare `continue`. Every entry logged before 2026-09-28 was a
 * runtime-upgrade block decoded against the wrong metadata (see
 * `DecodeSpecPlan` in materializeChainSilver.ts), since fixed and repaired
 * by `chain:repair-silver-upgrade-blocks`; an earlier investigation had
 * ruled that out because bronze's stamp matched a live read, but the live
 * read reports the post-block runtime too.
 *
 * Plain JSON Lines, not Parquet, deliberately: this is expected to stay
 * tiny (a handful of rows at most, tied to rare runtime-upgrade-boundary
 * blocks) and is read by a human investigating gaps, not queried at scale —
 * a full Parquet read-union-rewrite cycle (see `runtimeVersionsLog.ts`) per
 * skipped block would be needless overhead for that.
 */
export interface SkippedBlockEntry {
  blockNumber: number;
  specVersion: number;
  error: string;
}

function logPath(): string {
  return `${metaDir()}/materialize_silver_skipped_blocks.jsonl`;
}

export function appendSkippedBlock(entry: SkippedBlockEntry): void {
  mkdirSync(metaDir(), { recursive: true });
  const line = JSON.stringify({ ...entry, loggedAtMs: Date.now() });
  appendFileSync(logPath(), `${line}\n`, "utf-8");
}

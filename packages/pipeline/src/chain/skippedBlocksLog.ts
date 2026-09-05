import { appendFileSync, mkdirSync } from "node:fs";
import { metaDir } from "../paths.js";

/**
 * `/meta/materialize_silver_skipped_blocks.jsonl` — append-only audit trail
 * for blocks `materializeChainSilver` couldn't decode and skipped rather
 * than let crash the whole run (found for real 2026-08-29: a block sitting
 * exactly on a runtime-upgrade boundary hit a genuine `@polkadot/types`
 * SCALE-decode misalignment, confirmed *not* to be a bronze/metadata/
 * spec_version-stamping problem — bronze's raw bytes, the cached metadata,
 * and the spec_version all matched the live chain exactly). One bad block
 * out of ~8.9M must not block the other 8,999,999 from decoding; it must
 * also not vanish silently, hence this log rather than a bare `continue`.
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

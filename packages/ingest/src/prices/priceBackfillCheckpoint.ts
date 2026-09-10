import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { metaDir } from "../paths.js";

/**
 * Per-venue resume state for `ingest:backfill-prices`
 * (tao-analytics-plan.md §6, Phase 1.2) — "shut the computer down anytime,
 * continue the next day" without re-fetching years of already-backfilled
 * history. Keyed by `${exchange}:${pair}` rather than one scalar like the
 * chain backfill's checkpoint (`chain/backfillCheckpoint.ts`), because this
 * backfill runs many independent venues in one process and a restart must
 * resume each venue from where *it* left off, not from whichever venue
 * happened to be running when the process stopped.
 */
export interface PriceBackfillCheckpoint {
  [venueKey: string]: { lastWrittenMs: number; updatedAtMs: number };
}

function checkpointPath(): string {
  return `${metaDir()}/price_backfill_checkpoint.json`;
}

export function venueKey(exchange: string, pair: string): string {
  return `${exchange}:${pair}`;
}

export function readPriceBackfillCheckpoint(): PriceBackfillCheckpoint {
  const path = checkpointPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as PriceBackfillCheckpoint;
}

/**
 * Read-modify-write on the whole file. Safe here because one process
 * backfills all venues sequentially — there's never a concurrent writer to
 * race against, unlike the chain backfill which can run alongside
 * `sync-bronze.sh` on another machine.
 */
export function writePriceBackfillVenueCheckpoint(key: string, lastWrittenMs: number): void {
  mkdirSync(metaDir(), { recursive: true });
  const path = checkpointPath();
  const current = readPriceBackfillCheckpoint();
  current[key] = { lastWrittenMs, updatedAtMs: Date.now() };
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, JSON.stringify(current, null, 2), "utf-8");
  renameSync(tempPath, path);
}

export function clearPriceBackfillCheckpoint(): void {
  rmSync(checkpointPath(), { force: true });
}

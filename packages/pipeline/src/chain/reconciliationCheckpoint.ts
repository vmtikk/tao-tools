import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { asColdkey, asRao, type BalanceMap, type Coldkey, type Rao } from "@tao-tools/core";
import { metaDir } from "../paths.js";

/**
 * Resumability for `chain:reconcile-checkpoints` (added 2026-09-11, alongside
 * the `CHAIN_CONCURRENCY` fix in `concurrency.ts`/`reconcileBalances.ts` —
 * see that file's doc comment). Before this, a restart re-verified every
 * earlier window from scratch (see `runReconciliationCheckpoints.ts`'s own
 * doc comment, "no cross-run checkpoint persistence yet") — fine for a
 * fixture-sized test, not for a real multi-hour run against Pro that spends
 * real RU on every `state_getStorage` call it repeats.
 *
 * Keyed on `fromBlock` + `intervalBlocks` only, not `upToBlock` — mirrors
 * `materializeSilverCheckpoint.ts`'s reasoning exactly: `upToBlock` is
 * expected to grow across runs as more of the chain gets backfilled and
 * decoded, so an exact-range match would refuse to resume every time more
 * silver shows up. A checkpoint here just means "windows up to
 * `lastCompletedWindowEnd` are already reconciled" — rerunning with a larger
 * `UP_TO_BLOCK` picks up exactly where it left off and only processes the
 * newly-reachable windows.
 *
 * `knownGoodBalances` is carried as `[coldkey, raoDecimalString]` pairs, not
 * a `Map`/`bigint` directly — `JSON.stringify` can't serialize either, and a
 * decimal string round-trips a `Rao` exactly (see §3's "never floats" rule;
 * this is the same discipline applied to a checkpoint file, not just the
 * pipeline itself).
 */
export interface ReconciliationCheckpoint {
  fromBlock: number;
  intervalBlocks: number;
  lastCompletedWindowEnd: number;
  knownGoodBalances: [string, string][];
  totalMismatches: number;
  updatedAtMs: number;
}

function checkpointPath(): string {
  return `${metaDir()}/reconciliation_checkpoint.json`;
}

/**
 * Only returns a checkpoint matching this exact `[fromBlock, intervalBlocks]`
 * pair — a checkpoint from a differently-windowed run (or a test range) must
 * not silently redirect this one, same reasoning as `backfillCheckpoint.ts`'s
 * `readCheckpoint`.
 */
export function readReconciliationCheckpoint(fromBlock: number, intervalBlocks: number): ReconciliationCheckpoint | null {
  const path = checkpointPath();
  if (!existsSync(path)) return null;
  let parsed: ReconciliationCheckpoint;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as ReconciliationCheckpoint;
  } catch (err) {
    // Same recovery as readGoldShardCheckpoint: an unreadable checkpoint
    // (e.g. a hard power-off leaving NUL bytes) means exactly "we don't know
    // what's done" — restart rather than fail outright.
    console.warn(
      `readReconciliationCheckpoint: ignoring unreadable checkpoint at ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}) — restarting from fromBlock.`,
    );
    return null;
  }
  if (parsed.fromBlock !== fromBlock || parsed.intervalBlocks !== intervalBlocks) return null;
  return parsed;
}

export function writeReconciliationCheckpoint(checkpoint: ReconciliationCheckpoint): void {
  mkdirSync(metaDir(), { recursive: true });
  const path = checkpointPath();
  const tempPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), "utf-8");
  renameSync(tempPath, path);
}

export function clearReconciliationCheckpoint(): void {
  rmSync(checkpointPath(), { force: true });
}

export function encodeKnownGoodBalances(balances: BalanceMap): [string, string][] {
  return [...balances.entries()].map(([coldkey, rao]) => [coldkey, rao.toString()]);
}

export function decodeKnownGoodBalances(entries: readonly [string, string][]): BalanceMap {
  const balances = new Map<Coldkey, Rao>();
  for (const [coldkey, rao] of entries) {
    balances.set(asColdkey(coldkey), asRao(BigInt(rao)));
  }
  return balances;
}

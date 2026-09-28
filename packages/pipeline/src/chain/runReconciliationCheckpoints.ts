import type { BalanceEvent, BalanceMap, Coldkey, Rao } from "@tao-tools/core";
import type { BlockmachineClient } from "@tao-tools/ingest";
import { reconcileBalances, type ReconciliationRow } from "./reconcileBalances.js";

export interface CheckpointResult {
  fromBlock: number;
  toBlock: number;
  touchedAccounts: number;
  mismatches: readonly ReconciliationRow[];
}

export interface RunReconciliationCheckpointsOptions {
  client: BlockmachineClient;
  /** Size of each checkpoint window, in blocks. The plan's rough cadence is
   * "roughly monthly" (§7.1: "~13 of them" over the full history) — at
   * Bittensor's ~12s block time, one month is ~216,000 blocks, but this is
   * deliberately a parameter rather than a hardcoded constant since the
   * plan never pins an exact cadence. */
  intervalBlocks: number;
  /** Inclusive upper bound for the last checkpoint window — normally
   * whatever block the backfill (or at least `chain:materialize-silver`)
   * has actually reached, not the eventual chain head. A partial final
   * window (shorter than `intervalBlocks`) is silently skipped rather than
   * checked early against data that isn't fully materialized yet; rerun
   * once more blocks land. */
  upToBlock: number;
  /** Defaults to 1 (genesis) — the plan's monthly checkpoints start there. */
  fromBlock?: number;
  /** In-memory events instead of reading each window from silver — lets
   * tests exercise the windowing/carry-forward logic without real silver
   * Parquet files on disk. */
  events?: readonly BalanceEvent[];
  /** Forwarded to each `reconcileBalances` call — see its own doc comment.
   * Default 1 (sequential, the original behavior). */
  concurrency?: number;
  /**
   * Resume point for both the window walk and the balance state, as saved by
   * an earlier invocation's `onWindowComplete` (see `reconciliationCheckpoint.ts`).
   * Defaults to `fromBlock ?? 1` / an empty map — a fresh run from genesis (or
   * `fromBlock`), unchanged from before this option existed.
   */
  resumeFrom?: { windowStart: number; knownGoodBalances: BalanceMap };
  /**
   * Called synchronously after each window completes, before starting the
   * next one — the caller's hook for persisting a checkpoint. Awaited before
   * continuing, so a checkpoint is durably written before any further RPC
   * spend for the next window.
   */
  onWindowComplete?: (result: CheckpointResult, knownGoodBalances: BalanceMap) => void | Promise<void>;
}

/**
 * Runs `reconcileBalances` over consecutive, non-overlapping windows from
 * `fromBlock` to `upToBlock` (tao-analytics-plan.md §6, Phase 2.3's "Done
 * when: ...reconciles against monthly checkpoints", and §7.1's "Snapshots
 * become monthly reconciliation checkpoints... to verify reconstructed
 * balances haven't drifted"), carrying each checkpoint's validated balance
 * state into the next one via `knownGoodBalances` instead of re-folding
 * genesis-to-date and re-fetching every coldkey's on-chain balance at every
 * checkpoint — the same incremental idea as reconciling a bank statement
 * against last month's already-agreed closing balance, not your entire
 * transaction history back to account opening.
 *
 * Each window reads only its own slice of silver (a per-coldkey net change,
 * see `loadWindowNetDeltasFromSilver`). An earlier version loaded every
 * event in silver up front, which the full ~370M-event index can't fit in
 * memory.
 */
export async function runReconciliationCheckpoints(
  opts: RunReconciliationCheckpointsOptions,
): Promise<CheckpointResult[]> {
  if (opts.intervalBlocks <= 0) {
    throw new Error(`intervalBlocks must be positive, got ${opts.intervalBlocks}`);
  }

  const results: CheckpointResult[] = [];

  let knownGoodBalances: BalanceMap = opts.resumeFrom?.knownGoodBalances ?? new Map<Coldkey, Rao>();
  let windowStart = opts.resumeFrom?.windowStart ?? opts.fromBlock ?? 1;

  while (windowStart + opts.intervalBlocks - 1 <= opts.upToBlock) {
    const windowEnd = windowStart + opts.intervalBlocks - 1;

    const result = await reconcileBalances({
      fromBlock: windowStart,
      toBlock: windowEnd,
      client: opts.client,
      knownGoodBalances,
      events: opts.events,
      concurrency: opts.concurrency,
    });

    knownGoodBalances = result.balances;
    const checkpointResult: CheckpointResult = {
      fromBlock: windowStart,
      toBlock: windowEnd,
      touchedAccounts: result.touchedAccounts,
      mismatches: result.rows.filter((row) => !row.matches),
    };
    results.push(checkpointResult);
    await opts.onWindowComplete?.(checkpointResult, knownGoodBalances);

    windowStart = windowEnd + 1;
  }

  return results;
}

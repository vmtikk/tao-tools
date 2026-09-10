import type { DuckDBConnection } from "@duckdb/node-api";

export interface ReconciliationRpcWindowEstimate {
  windowIndex: number;
  fromBlock: number;
  toBlock: number;
  /** Coldkeys touched by an event in this window — one `state_getStorage`
   * read each at the window's end block, regardless of whether they were
   * seen before. */
  touchedAccounts: number;
  /** Subset of `touchedAccounts` touched here for the first time across the
   * whole estimated range — one *additional* `state_getStorage` read each,
   * for the baseline at the window's start block. */
  newlyTouchedAccounts: number;
}

export interface ReconciliationRpcEstimate {
  fromBlock: number;
  upToBlock: number;
  intervalBlocks: number;
  windows: ReconciliationRpcWindowEstimate[];
  /** SUM(touchedAccounts) — the dominant term: every touched coldkey gets a
   * real `System.Account` read every window it's touched in. */
  totalActualReads: number;
  /** SUM(newlyTouchedAccounts) — equals the number of distinct coldkeys
   * touched anywhere in [fromBlock, last complete window's end], since
   * `knownGoodBalances` accumulates forever once a coldkey is seen
   * (reconcileBalances.ts). */
  totalBaselineReads: number;
  /** 3 calls/window: `chain_getBlockHash` at the window's start-1 and end,
   * plus `state_getRuntimeVersion` at the end hash. Does not count the
   * `state_getMetadata` fallback in `loadRegistryForBlock` — that only
   * fires on a spec_version cache miss, and the backfill already cached
   * every spec_version seen into bronze. */
  totalWindowOverheadCalls: number;
  totalCalls: number;
}

/**
 * Estimates the RPC call count a real `chain:reconcile-checkpoints` run
 * would make, using only already-decoded silver — no network access
 * (tao-analytics-plan.md §6, closeout item 3: "Size it before spending any
 * [RU budget]").
 *
 * Mirrors `reconcileBalances`'s own accounting exactly rather than
 * approximating it: `connection` must already have `silver_transfers`
 * (`from_coldkey`, `to_coldkey`, `block_number`) and `silver_balance_events`
 * (`coldkey`, `block_number`) available as tables or views — same shape
 * `materializeGold` creates them as. A coldkey touched more than once in one
 * window still costs one `state_getStorage` read there (`DISTINCT`); a
 * partial trailing window that doesn't fill `intervalBlocks` is dropped,
 * matching `runReconciliationCheckpoints`'s own `while` condition.
 */
export async function estimateReconciliationRpc(
  connection: DuckDBConnection,
  opts: { fromBlock: number; upToBlock: number; intervalBlocks: number },
): Promise<ReconciliationRpcEstimate> {
  const fromBlock = Math.trunc(opts.fromBlock);
  const upToBlock = Math.trunc(opts.upToBlock);
  const intervalBlocks = Math.trunc(opts.intervalBlocks);
  if (intervalBlocks <= 0) {
    throw new Error(`intervalBlocks must be positive, got ${intervalBlocks}`);
  }

  const numWindows = Math.floor((upToBlock - fromBlock + 1) / intervalBlocks);
  if (numWindows <= 0) {
    return {
      fromBlock,
      upToBlock,
      intervalBlocks,
      windows: [],
      totalActualReads: 0,
      totalBaselineReads: 0,
      totalWindowOverheadCalls: 0,
      totalCalls: 0,
    };
  }

  const lastCoveredBlock = fromBlock + numWindows * intervalBlocks - 1;

  const result = await connection.run(`
    WITH touches AS (
      SELECT from_coldkey AS coldkey, block_number FROM silver_transfers
      WHERE block_number >= ${fromBlock} AND block_number <= ${lastCoveredBlock}
      UNION ALL
      SELECT to_coldkey AS coldkey, block_number FROM silver_transfers
      WHERE block_number >= ${fromBlock} AND block_number <= ${lastCoveredBlock}
      UNION ALL
      SELECT coldkey, block_number FROM silver_balance_events
      WHERE block_number >= ${fromBlock} AND block_number <= ${lastCoveredBlock}
    ),
    windowed AS (
      SELECT DISTINCT coldkey, CAST((block_number - ${fromBlock}) / ${intervalBlocks} AS BIGINT) AS window_index
      FROM touches
    ),
    per_window_touch AS (
      SELECT window_index, COUNT(*) AS touched FROM windowed GROUP BY window_index
    ),
    first_seen AS (
      SELECT coldkey, MIN(window_index) AS first_window FROM windowed GROUP BY coldkey
    ),
    per_window_new AS (
      SELECT first_window AS window_index, COUNT(*) AS newly FROM first_seen GROUP BY first_window
    ),
    all_windows AS (
      SELECT generate_series AS window_index FROM generate_series(0, ${numWindows - 1})
    )
    SELECT
      w.window_index,
      COALESCE(t.touched, 0) AS touched,
      COALESCE(n.newly, 0) AS newly
    FROM all_windows w
    LEFT JOIN per_window_touch t ON t.window_index = w.window_index
    LEFT JOIN per_window_new n ON n.window_index = w.window_index
    ORDER BY w.window_index;
  `);
  const rows = await result.getRows();

  const windows: ReconciliationRpcWindowEstimate[] = rows.map((row) => {
    const windowIndex = Number(row[0]);
    const windowFromBlock = fromBlock + windowIndex * intervalBlocks;
    return {
      windowIndex,
      fromBlock: windowFromBlock,
      toBlock: windowFromBlock + intervalBlocks - 1,
      touchedAccounts: Number(row[1]),
      newlyTouchedAccounts: Number(row[2]),
    };
  });

  const totalActualReads = windows.reduce((sum, w) => sum + w.touchedAccounts, 0);
  const totalBaselineReads = windows.reduce((sum, w) => sum + w.newlyTouchedAccounts, 0);
  const totalWindowOverheadCalls = windows.length * 3;

  return {
    fromBlock,
    upToBlock,
    intervalBlocks,
    windows,
    totalActualReads,
    totalBaselineReads,
    totalWindowOverheadCalls,
    totalCalls: totalActualReads + totalBaselineReads + totalWindowOverheadCalls,
  };
}

import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { estimateReconciliationRpc } from "../src/chain/estimateReconciliationRpc.js";

/**
 * Tier 2 (tao-analytics-plan.md §5): sizes chain:reconcile-checkpoints
 * against a small hand-authored fixture, mirroring the exact
 * touched/newly-touched accounting reconcileBalances.ts uses for real, so
 * this estimate can't silently diverge from what a real run would cost.
 */
describe("estimateReconciliationRpc", () => {
  async function setUp(connection: Parameters<Parameters<typeof withDuckDb>[0]>[0]) {
    await connection.run(`
      CREATE TABLE silver_transfers (
        block_number BIGINT, event_index INTEGER, from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
      );
    `);
    await connection.run(`
      CREATE TABLE silver_balance_events (
        block_number BIGINT, event_index INTEGER, kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
      );
    `);
  }

  it("counts touched accounts per window and newly-touched only on first appearance", async () => {
    const estimate = await withDuckDb(async (connection) => {
      await setUp(connection);
      // Window 0: blocks 1-10. Window 1: blocks 11-20.
      await connection.run(`
        INSERT INTO silver_balance_events VALUES (1, 0, 'deposit', '5Alice', 1000);
      `);
      await connection.run(`
        INSERT INTO silver_transfers VALUES
          (5, 0, '5Alice', '5Bob', 100),
          (15, 0, '5Bob', '5Alice', 50);
      `);
      return estimateReconciliationRpc(connection, { fromBlock: 1, upToBlock: 20, intervalBlocks: 10 });
    });

    expect(estimate.windows).toEqual([
      // Window 0: Alice (deposit + transfer-out) and Bob (transfer-in) both touched, both new.
      { windowIndex: 0, fromBlock: 1, toBlock: 10, touchedAccounts: 2, newlyTouchedAccounts: 2 },
      // Window 1: both touched again (transfer back), but neither is new.
      { windowIndex: 1, fromBlock: 11, toBlock: 20, touchedAccounts: 2, newlyTouchedAccounts: 0 },
    ]);
    expect(estimate.totalActualReads).toBe(4);
    expect(estimate.totalBaselineReads).toBe(2);
    expect(estimate.totalWindowOverheadCalls).toBe(6);
    expect(estimate.totalCalls).toBe(12);
  });

  it("counts a coldkey touched twice in the same window once", async () => {
    const estimate = await withDuckDb(async (connection) => {
      await setUp(connection);
      await connection.run(`
        INSERT INTO silver_transfers VALUES
          (2, 0, '5Alice', '5Bob', 10),
          (4, 0, '5Alice', '5Carol', 10);
      `);
      return estimateReconciliationRpc(connection, { fromBlock: 1, upToBlock: 10, intervalBlocks: 10 });
    });

    expect(estimate.windows).toEqual([
      { windowIndex: 0, fromBlock: 1, toBlock: 10, touchedAccounts: 3, newlyTouchedAccounts: 3 },
    ]);
  });

  it("drops a partial trailing window", async () => {
    const estimate = await withDuckDb(async (connection) => {
      await setUp(connection);
      await connection.run(`INSERT INTO silver_balance_events VALUES (15, 0, 'deposit', '5Alice', 10);`);
      // upToBlock=15 with intervalBlocks=10 fits only window 0 (blocks 1-10);
      // the event at block 15 falls in the incomplete window 11-20 and must not be counted.
      return estimateReconciliationRpc(connection, { fromBlock: 1, upToBlock: 15, intervalBlocks: 10 });
    });

    expect(estimate.windows).toEqual([
      { windowIndex: 0, fromBlock: 1, toBlock: 10, touchedAccounts: 0, newlyTouchedAccounts: 0 },
    ]);
  });

  it("returns an empty estimate when no window fits", async () => {
    const estimate = await withDuckDb(async (connection) => {
      await setUp(connection);
      return estimateReconciliationRpc(connection, { fromBlock: 1, upToBlock: 5, intervalBlocks: 10 });
    });

    expect(estimate.windows).toEqual([]);
    expect(estimate.totalCalls).toBe(0);
  });
});

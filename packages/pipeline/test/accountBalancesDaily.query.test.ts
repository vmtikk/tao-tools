import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Tier 2 (tao-analytics-plan.md §5): the registry SQL run verbatim against a
 * small hand-authored fixture, same pattern as transferCountPerBlock.query.test.ts.
 */
describe("account_balances_daily registry SQL", () => {
  it("folds transfers and balance_events into a per-coldkey, per-day-with-activity balance", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "account_balances_daily");
    if (!entry) throw new Error('registry has no "account_balances_daily" entry');

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        CREATE TABLE silver_balance_events (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      // Day 0: Alice genesis-funded (deposit, no transfer — the
      // genesis-funded-accounts gap reconcileBalances.ts documents).
      await connection.run(`
        INSERT INTO silver_balance_events VALUES
          (1, 0, 0, 'deposit', '5Alice', 5000000000),
          (300, 0, 259200000, 'withdraw', '5Alice', 10000000);
      `);
      // Day 1: Alice -> Bob. Day 2: Bob -> Carol.
      await connection.run(`
        INSERT INTO silver_transfers VALUES
          (100, 0, 86400000, '5Alice', '5Bob', 4990000000),
          (200, 0, 172800000, '5Bob', '5Carol', 4990000000);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [String(r[0]), Number(r[1]), Number(r[2])])).toEqual([
      ["5Alice", 0, 5000000000],
      ["5Alice", 86400000, 10000000],
      ["5Alice", 259200000, 0],
      ["5Bob", 86400000, 4990000000],
      ["5Bob", 172800000, 0],
      ["5Carol", 172800000, 4990000000],
    ]);
  });

  /**
   * A transfer becomes two delta rows sharing one (block_number, event_index),
   * so a self-transfer puts both legs in the same coldkey's partition with
   * identical sort keys. v1 picked the day's last row with
   * "ROW_NUMBER() ... ORDER BY block_number DESC, event_index DESC", which
   * ties there and resolves arbitrarily — it could report the running sum
   * after one leg but not the other, i.e. a balance off by the whole transfer
   * amount, differently between runs on identical input. Found on real data
   * 2026-09-09: 103 self-transfers across 44 coldkeys, one off by exactly
   * 90000000 rao. A self-transfer must net to zero.
   */
  it("nets a self-transfer to zero instead of tie-breaking between its two legs", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "account_balances_daily")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        CREATE TABLE silver_balance_events (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        INSERT INTO silver_balance_events VALUES (1, 0, 0, 'deposit', '5Alice', 1000000000);
      `);
      // Alice sends to herself as the last event of day 1 — exactly the shape
      // that made v1 ambiguous.
      await connection.run(`
        INSERT INTO silver_transfers VALUES (100, 7, 86400000, '5Alice', '5Alice', 90000000);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [String(r[0]), Number(r[1]), Number(r[2])])).toEqual([
      ["5Alice", 0, 1000000000],
      // Unchanged by the self-transfer — not 910000000 or 1090000000.
      ["5Alice", 86400000, 1000000000],
    ]);
  });

  it("returns no rows when silver has no chain events yet", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "account_balances_daily")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        CREATE TABLE silver_balance_events (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows).toEqual([]);
  });
});

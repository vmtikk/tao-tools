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

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Tier 2 (tao-analytics-plan.md §5, §7.1): runs the crossing-detection +
 * forward-fill SQL verbatim against a hand-authored `account_balances_daily`
 * fixture (the shape materializeGold's dependency wiring produces from that
 * metric's own gold Parquet — see accountBalancesDaily.query.test.ts for how
 * those sparse rows themselves get derived from transfers/balance_events).
 *
 * Fixture: Alice genesis-funded with 5 TAO (day 0); sends 4.99 TAO to Bob on
 * day 1, leaving herself exactly 0.01 TAO (the dust threshold — must NOT
 * count as dust-filtered, since §7.1 defines it as "> 0.01 TAO"); Bob sends
 * his full 4.99 TAO to Carol on day 2 (a net-zero day for both series, since
 * one coldkey leaves the set and another enters it on the same day — this
 * exercises that the forward-fill doesn't drop a day just because nothing
 * net changed); Alice's dust is swept out (withdraw) on day 3.
 */
function seedAccountBalancesDaily(sql: string) {
  return withDuckDb(async (connection) => {
    await connection.run(`
      CREATE TABLE account_balances_daily (
        coldkey VARCHAR, timestamp_ms BIGINT, balance_rao BIGINT
      );
    `);
    await connection.run(`
      INSERT INTO account_balances_daily VALUES
        ('5Alice', 0,         5000000000),
        ('5Alice', 86400000,  10000000),
        ('5Bob',   86400000,  4990000000),
        ('5Bob',   172800000, 0),
        ('5Carol', 172800000, 4990000000),
        ('5Alice', 259200000, 0);
    `);
    const result = await connection.run(sql);
    return result.getRows();
  });
}

describe("wallet_count_free_balance registry SQL", () => {
  it("counts distinct coldkeys with balance > 0, forward-filled across every day in range", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "wallet_count_free_balance");
    if (!entry) throw new Error('registry has no "wallet_count_free_balance" entry');

    const rows = await seedAccountBalancesDaily(entry.sql);

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [0, 1], // Alice funded
      [86400000, 2], // Alice still > 0 (0.01 TAO), Bob newly funded
      [172800000, 2], // Bob -> Carol: net zero, but the day must still appear
      [259200000, 1], // Alice's dust swept out
    ]);
  });
});

describe("wallet_count_dust_filtered registry SQL", () => {
  it("excludes balances at or below the 0.01 TAO dust threshold", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "wallet_count_dust_filtered");
    if (!entry) throw new Error('registry has no "wallet_count_dust_filtered" entry');

    const rows = await seedAccountBalancesDaily(entry.sql);

    // Alice's 0.01 TAO (exactly the threshold) never counts; whichever of
    // Alice/Bob/Carol holds the real 4.99 TAO balance does, so the count
    // stays flat at 1 throughout even though the holder changes.
    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [0, 1],
      [86400000, 1],
      [172800000, 1],
      [259200000, 1],
    ]);
  });
});

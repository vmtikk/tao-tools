import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Tier 2 (tao-analytics-plan.md §5, §7.2): runs the crossing-free dense
 * forward-fill SQL verbatim against a hand-authored `account_balances_daily`
 * + `exchange_labels` fixture (the shapes materializeGold's view wiring
 * produces — the first from account_balances_daily's own gold Parquet, the
 * second read directly from data/meta/exchange_labels.json).
 *
 * Fixture: two labeled exchange coldkeys (Kraken, Binance) and one
 * unlabeled coldkey (Alice — a regular user, must NOT be summed in).
 * Kraken funded on day 0 with 100 TAO; Binance funded on day 1 with 50 TAO;
 * Kraken sends 20 TAO to Alice on day 2 (Kraken drops to 80, Alice — not
 * labeled — never appears in the output at all).
 */
function seedFixture(sql: string) {
  return withDuckDb(async (connection) => {
    await connection.run(`
      CREATE TABLE account_balances_daily (
        coldkey VARCHAR, timestamp_ms BIGINT, balance_rao BIGINT
      );
    `);
    await connection.run(`
      INSERT INTO account_balances_daily VALUES
        ('5Kraken', 0,         100000000000),
        ('5Binance', 86400000, 50000000000),
        ('5Kraken', 172800000, 80000000000),
        ('5Alice',  172800000, 20000000000);
    `);
    await connection.run(`
      CREATE TABLE exchange_labels (
        coldkey VARCHAR, exchange VARCHAR, confidence VARCHAR, date_added VARCHAR, evidence VARCHAR
      );
    `);
    await connection.run(`
      INSERT INTO exchange_labels VALUES
        ('5Kraken', 'Kraken', 'medium', '2026-09-05', 'test fixture'),
        ('5Binance', 'Binance', 'medium', '2026-09-05', 'test fixture');
    `);
    const result = await connection.run(sql);
    return result.getRows();
  });
}

describe("exchange_balances_daily registry SQL", () => {
  it("sums only labeled coldkeys' balances, forward-filled across the full date range", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "exchange_balances_daily");
    if (!entry) throw new Error('registry has no "exchange_balances_daily" entry');

    const rows = await seedFixture(entry.sql);

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [0, 100], // Kraken only, 100 TAO
      [86400000, 150], // + Binance's 50 TAO
      [172800000, 130], // Kraken -20 TAO to unlabeled Alice, who never counts
    ]);
  });

  it("returns no rows when no exchange labels exist yet", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "exchange_balances_daily")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE account_balances_daily (
          coldkey VARCHAR, timestamp_ms BIGINT, balance_rao BIGINT
        );
      `);
      await connection.run(`
        INSERT INTO account_balances_daily VALUES ('5Alice', 0, 1000000000);
      `);
      await connection.run(`
        CREATE TABLE exchange_labels (
          coldkey VARCHAR, exchange VARCHAR, confidence VARCHAR, date_added VARCHAR, evidence VARCHAR
        );
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows).toEqual([]);
  });
});

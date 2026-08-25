import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

async function seedSilver(connection: Parameters<Parameters<typeof withDuckDb>[0]>[0]) {
  await connection.run(`
    CREATE TABLE silver_ohlcv_1m (
      exchange VARCHAR, pair VARCHAR, timestamp_ms BIGINT,
      open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
      base_volume DOUBLE, quote_volume DOUBLE, is_partial BOOLEAN
    );
  `);
  await connection.run(`
    INSERT INTO silver_ohlcv_1m VALUES
      -- USD pair, one bucket, two venues
      ('kraken',   'TAOUSD',  1000, 100, 100, 100, 100, 0.5, 50, false),
      ('coinbase', 'TAOUSD',  1000, 110, 110, 110, 110, 0.45, 50, false),
      -- USDT pair folded into the USD composite/volume
      ('binance',  'TAOUSDT', 1000, 105, 105, 105, 105, 1,   100, false),
      -- BTC pair, must not leak into the USD composite or volume
      ('kraken',   'TAOBTC',  1000, 0.002, 0.002, 0.002, 0.002, 10, 0.02, false),
      ('upbit',    'TAOBTC',  2000, 0.0021, 0.0021, 0.0021, 0.0021, 5, 0.0105, false);
  `);
}

describe("price_composite_btc registry SQL", () => {
  it("composites only the TAOBTC pair, ignoring USD/USDT rows", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_btc");
    if (!entry) throw new Error('registry has no "price_composite_btc" entry');

    const rows = await withDuckDb(async (connection) => {
      await seedSilver(connection);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [1000, 0.002],
      [2000, 0.0021],
    ]);
  });
});

describe("volume_usd_daily registry SQL", () => {
  it("sums USD+USDT quote volume per day, excluding BTC-quoted rows", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "volume_usd_daily");
    if (!entry) throw new Error('registry has no "volume_usd_daily" entry');

    const rows = await withDuckDb(async (connection) => {
      await seedSilver(connection);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    // day bucket for timestamp_ms=1000 is 0; volume = 50 + 50 + 100 = 200 (BTC excluded)
    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([[0, 200]]);
  });
});

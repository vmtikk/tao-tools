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

/**
 * `price_composite_btc` (registry v2, 2026-09-10) no longer reads a real
 * TAOBTC pair from silver_ohlcv_1m at all — no reputable exchange lists one
 * (see the registry's changelog). It's now an implied cross-rate,
 * `price_composite_usd ÷ reference_btc_usd`, wired via `depends_on` the same
 * way `materializeGold` wires any metric's dependency: as a queryable view
 * over the dependency's own already-materialized gold output. This test
 * stands those two views up directly with fixture rows, matching that
 * contract, rather than seeding raw OHLCV.
 */
describe("price_composite_btc registry SQL", () => {
  it("derives the implied TAO/BTC ratio from price_composite_usd and reference_btc_usd", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_btc");
    if (!entry) throw new Error('registry has no "price_composite_btc" entry');

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE price_composite_usd (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`CREATE TABLE reference_btc_usd (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`
        INSERT INTO price_composite_usd VALUES (1000, 500), (2000, 750);
      `);
      await connection.run(`
        INSERT INTO reference_btc_usd VALUES (1000, 50000), (2000, 50000);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [1000, 0.01],
      [2000, 0.015],
    ]);
  });

  it("excludes a bucket where reference_btc_usd is zero, rather than dividing by it", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_btc")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE price_composite_usd (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`CREATE TABLE reference_btc_usd (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`INSERT INTO price_composite_usd VALUES (1000, 500);`);
      await connection.run(`INSERT INTO reference_btc_usd VALUES (1000, 0);`);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows).toEqual([]);
  });
});

/**
 * Tier 2: price_composite_btc_daily (registry v1, added 2026-09-10 — same
 * reason and day as price_composite_usd_daily: the 1-minute implied series
 * mirrors price_composite_usd's row count exactly, so it was equally
 * oversized for the web chart).
 */
describe("price_composite_btc_daily registry SQL", () => {
  it("takes the last 1-minute implied value of each UTC day", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_btc_daily");
    if (!entry) throw new Error('registry has no "price_composite_btc_daily" entry');

    const DAY_MS = 86_400_000;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE price_composite_btc (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`
        INSERT INTO price_composite_btc VALUES
          (0, 0.01),
          (60000, 0.011),
          (${DAY_MS}, 0.02);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [0, 0.011],
      [DAY_MS, 0.02],
    ]);
  });
});

/**
 * Tier 2: price_composite_btc_weekly (registry v1, added 2026-09-10 —
 * same day as price_composite_usd_weekly, see its test for the
 * Monday-alignment rationale).
 */
describe("price_composite_btc_weekly registry SQL", () => {
  it("takes the last daily implied value of each ISO (Monday-aligned) week", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_btc_weekly");
    if (!entry) throw new Error('registry has no "price_composite_btc_weekly" entry');

    const mon13 = Date.UTC(2023, 10, 13);
    const sun19 = Date.UTC(2023, 10, 19);
    const mon20 = Date.UTC(2023, 10, 20);

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE price_composite_btc_daily (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`
        INSERT INTO price_composite_btc_daily VALUES
          (${mon13}, 0.01),
          (${sun19}, 0.012),
          (${mon20}, 0.02);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [mon13, 0.012],
      [mon20, 0.02],
    ]);
  });
});

/**
 * Registry v2 (2026-09-10): Binance-only, not summed across every polled
 * venue — see the registry's changelog for why (venues came online at very
 * different dates, so a multi-venue sum jumped every time a new one started,
 * not because trading activity actually changed).
 */
describe("volume_usd_daily registry SQL", () => {
  it("sums only Binance's quote volume per day, excluding other venues and BTC-quoted rows", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "volume_usd_daily");
    if (!entry) throw new Error('registry has no "volume_usd_daily" entry');

    const rows = await withDuckDb(async (connection) => {
      await seedSilver(connection);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    // day bucket for timestamp_ms=1000 is 0; volume = 100 (binance only —
    // kraken's 50 and coinbase's 50 are excluded, not summed in; BTC excluded too)
    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([[0, 100]]);
  });

  it("excludes Binance rows quoted in something other than TAOUSDT", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "volume_usd_daily")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_ohlcv_1m (
          exchange VARCHAR, pair VARCHAR, timestamp_ms BIGINT,
          open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
          base_volume DOUBLE, quote_volume DOUBLE, is_partial BOOLEAN
        );
      `);
      await connection.run(`
        INSERT INTO silver_ohlcv_1m VALUES
          ('binance', 'TAOUSDT', 1000, 100, 100, 100, 100, 1, 50, false),
          ('binance', 'BTCUSDT', 1000, 60000, 60000, 60000, 60000, 1, 60000, false);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([[0, 50]]);
  });
});

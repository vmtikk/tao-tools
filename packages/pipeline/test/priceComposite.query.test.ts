import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Tier 2 (tao-analytics-plan.md §5): spins an in-memory DuckDB, loads a
 * small hand-authored fixture, runs the registry entry's SQL verbatim, and
 * asserts the output rows. This is what catches the registry SQL silently
 * disagreeing with the core composite logic it's supposed to mirror.
 */
describe("price_composite_usd registry SQL", () => {
  it("volume-weights same-bucket venues and excludes zero-volume buckets", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_usd");
    if (!entry) throw new Error('registry has no "price_composite_usd" entry');

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
          ('kraken',   'TAOUSD', 1000, 100, 100, 100, 100, 0.5,  50, false),
          ('coinbase', 'TAOUSD', 1000, 110, 110, 110, 110, 0.45, 50, false),
          ('kraken',   'TAOUSD', 2000, 200, 200, 200, 200, 0.05, 10, false),
          ('kraken',   'TAOUSD', 3000, 300, 300, 300, 300, 0,     0, false),
          ('coinbase', 'TAOUSD', 3000, 305, 305, 305, 305, 0,     0, false);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [1000, 105], // (100*50 + 110*50) / 100
      [2000, 200], // single-venue passthrough
      // t=3000 excluded: zero quote volume on every venue
    ]);
  });
});

/**
 * Tier 2: price_composite_usd_daily (registry v1, added 2026-09-10 —
 * see price_composite_usd's v3 changelog for why the 1-minute series
 * stopped shipping to the web chart). depends_on wires its own gold output
 * as a plain view named "price_composite_usd", matching how materializeGold
 * actually exposes a dependency (see gold/materialize.ts).
 */
describe("price_composite_usd_daily registry SQL", () => {
  it("takes the last 1-minute value of each UTC day, not the first or an average", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_usd_daily");
    if (!entry) throw new Error('registry has no "price_composite_usd_daily" entry');

    const DAY_MS = 86_400_000;
    const day0 = 0;
    const day1 = DAY_MS;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE price_composite_usd (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`
        INSERT INTO price_composite_usd VALUES
          (${day0}, 100),
          (${day0 + 60_000}, 105),
          (${day0 + 120_000}, 110),
          (${day1}, 200),
          (${day1 + 60_000}, 195);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [day0, 110], // last value of day 0, not the first (100) or the average
      [day1, 195], // last value of day 1
    ]);
  });
});

/**
 * Tier 2: price_composite_usd_weekly (registry v1, added 2026-09-10 — a
 * days/weeks-focused viewer confirmed 1-minute/hourly resolution is
 * unnecessary). Monday-aligned ISO weeks, not naive epoch-ms division —
 * 1970-01-01 was a Thursday, so floor(ts / weekMs) would misalign every
 * bucket boundary to Thursdays instead of the expected Monday start.
 */
describe("price_composite_usd_weekly registry SQL", () => {
  it("takes the last daily value of each ISO (Monday-aligned) week", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "price_composite_usd_weekly");
    if (!entry) throw new Error('registry has no "price_composite_usd_weekly" entry');

    const mon13 = Date.UTC(2023, 10, 13); // Monday — week 1 start
    const wed15 = Date.UTC(2023, 10, 15); // Wednesday, same week
    const sun19 = Date.UTC(2023, 10, 19); // Sunday, same week — its last day
    const mon20 = Date.UTC(2023, 10, 20); // Monday — week 2 start

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE price_composite_usd_daily (timestamp_ms BIGINT, value DOUBLE);`);
      await connection.run(`
        INSERT INTO price_composite_usd_daily VALUES
          (${mon13}, 100),
          (${wed15}, 105),
          (${sun19}, 110),
          (${mon20}, 200);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [mon13, 110], // week of Nov 13-19: last day (Sun 19) wins, not the first or middle
      [mon20, 200], // week of Nov 20-26, only one day so far
    ]);
  });
});

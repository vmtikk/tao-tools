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

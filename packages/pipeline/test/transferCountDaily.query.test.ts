import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Tier 2 (tao-analytics-plan.md §5): the registry SQL run verbatim against a
 * small hand-authored fixture, same pattern as priceComposite.query.test.ts.
 *
 * v2 (2026-09-05): rebucketed from per-block to per-UTC-day — per-block
 * resolution produced 1.3M points against the real ~5.8M-block backfill
 * prefix, which neither loads nor renders in a browser. See the registry
 * entry's changelog.
 */
describe("transfer_count_daily registry SQL", () => {
  it("counts transfers grouped by UTC day, merging same-day timestamps", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "transfer_count_daily");
    if (!entry) throw new Error('registry has no "transfer_count_daily" entry');

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        INSERT INTO silver_transfers VALUES
          (10, 0, 1000,     '5Alice', '5Bob',   1000000000),
          (10, 1, 5000,     '5Bob',   '5Carol',  500000000),
          (11, 0, 86401000, '5Carol', '5Alice',  200000000);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [0, 2], // day 0: the two transfers at ts=1000 and ts=5000, merged
      [86400000, 1], // day 1: the transfer at ts=86401000
    ]);
  });

  it("returns no rows when silver_transfers is empty (the Phase 2.1 tracer-bullet window observed in practice)", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "transfer_count_daily")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows).toEqual([]);
  });
});

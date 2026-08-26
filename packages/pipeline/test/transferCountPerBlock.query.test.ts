import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Tier 2 (tao-analytics-plan.md §5): the registry SQL run verbatim against a
 * small hand-authored fixture, same pattern as priceComposite.query.test.ts.
 */
describe("transfer_count_per_block registry SQL", () => {
  it("counts transfers grouped by their block's timestamp", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "transfer_count_per_block");
    if (!entry) throw new Error('registry has no "transfer_count_per_block" entry');

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        INSERT INTO silver_transfers VALUES
          (10, 0, 5000, '5Alice', '5Bob',   1000000000),
          (10, 1, 5000, '5Bob',   '5Carol',  500000000),
          (11, 0, 5012, '5Carol', '5Alice',  200000000);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [5000, 2],
      [5012, 1],
    ]);
  });

  it("returns no rows when silver_transfers is empty (the Phase 2.1 tracer-bullet window observed in practice)", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "transfer_count_per_block")!;

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

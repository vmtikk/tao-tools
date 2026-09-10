import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

describe("social_trends_bittensor_weekly registry SQL", () => {
  it("selects only the Bittensor keyword's points, ordered by week", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "social_trends_bittensor_weekly");
    if (!entry) throw new Error('registry has no "social_trends_bittensor_weekly" entry');

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_google_trends (
          keyword VARCHAR, week_start_ms BIGINT, value DOUBLE, is_partial BOOLEAN, fetched_at_ms BIGINT
        );
      `);
      await connection.run(`
        INSERT INTO silver_google_trends VALUES
          ('Bittensor', 604800000, 12, false, 1000),
          ('Bittensor', 0, 10, false, 1000),
          ('tao crypto', 0, 40, false, 1000);
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [0, 10],
      [604800000, 12],
    ]);
  });

  it("produces an empty series against the empty-typed fallback view (no Trends bronze run yet)", async () => {
    const entries = loadRegistry(REGISTRY_PATH);
    const entry = entries.find((e) => e.name === "social_trends_bittensor_weekly")!;

    const rows = await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE silver_google_trends (
          keyword VARCHAR, week_start_ms BIGINT, value DOUBLE, is_partial BOOLEAN, fetched_at_ms BIGINT
        );
      `);
      const result = await connection.run(entry.sql);
      return result.getRows();
    });

    expect(rows).toEqual([]);
  });
});

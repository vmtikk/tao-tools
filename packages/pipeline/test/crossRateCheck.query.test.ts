import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { materializeSilverOhlcv } from "../src/silver/materializeOhlcv.js";
import { materializeGold } from "../src/gold/materialize.js";
import { runCrossRateCheck } from "../src/crossRate/runCheck.js";

/**
 * Integration test for the Phase 1.3 scheduled assertion (§4.1, §6): runs
 * the real bronze -> silver -> gold path against a fixture with a clean
 * bucket and a planted 5%+ drift, and asserts the check only flags the
 * planted one.
 */
describe("runCrossRateCheck (integration)", () => {
  const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

  let tempRoot: string;
  let prevDataRoot: string | undefined;
  let prevBronzeUri: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-cross-rate-"));
    prevDataRoot = process.env.DATA_ROOT;
    prevBronzeUri = process.env.BRONZE_URI;
    process.env.DATA_ROOT = join(tempRoot, "data");
    process.env.BRONZE_URI = join(tempRoot, "data", "bronze");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    process.env.BRONZE_URI = prevBronzeUri;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("flags only the bucket with a planted cross-rate drift", async () => {
    const writeBronze = async (pair: string, rows: string) => {
      const dir = join(tempRoot, "data", "bronze", "prices", "kraken", pair);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "2026-08.parquet").replace(/\\/g, "/");
      await withDuckDb(async (connection) => {
        await connection.run(`
          CREATE TABLE staged (
            exchange VARCHAR, pair VARCHAR, timestamp_ms BIGINT,
            open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
            base_volume DOUBLE, quote_volume DOUBLE, is_partial BOOLEAN
          );
        `);
        await connection.run(`INSERT INTO staged VALUES ${rows};`);
        await connection.run(`COPY staged TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
      });
    };

    // t=1000: implied 500/50000 = 0.01, matches observed TAO/BTC of 0.01 — clean.
    // t=2000: implied 500/50000 = 0.01, but observed TAO/BTC is 0.02 — planted drift.
    await writeBronze(
      "TAOUSD",
      `('kraken', 'TAOUSD', 1000, 500, 500, 500, 500, 1, 100, false),
       ('kraken', 'TAOUSD', 2000, 500, 500, 500, 500, 1, 100, false)`,
    );
    await writeBronze(
      "BTCUSD",
      `('kraken', 'BTCUSD', 1000, 50000, 50000, 50000, 50000, 1, 100, false),
       ('kraken', 'BTCUSD', 2000, 50000, 50000, 50000, 50000, 1, 100, false)`,
    );
    await writeBronze(
      "TAOBTC",
      `('kraken', 'TAOBTC', 1000, 0.01, 0.01, 0.01, 0.01, 1, 100, false),
       ('kraken', 'TAOBTC', 2000, 0.02, 0.02, 0.02, 0.02, 1, 100, false)`,
    );

    await materializeSilverOhlcv();
    await materializeGold(REGISTRY_PATH);

    const { divergences } = await runCrossRateCheck();
    expect(divergences).toHaveLength(1);
    expect(divergences[0]).toMatchObject({ timestampMs: 2000, observedTaoBtc: 0.02 });
    expect(divergences[0]!.divergence).toBeGreaterThan(0.05);
  });
});

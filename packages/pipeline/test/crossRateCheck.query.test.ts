import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { materializeSilverOhlcv } from "../src/silver/materializeOhlcv.js";
import { materializeGold } from "../src/gold/materialize.js";
import { runCrossRateCheck } from "../src/crossRate/runCheck.js";
import { goldDir } from "../src/paths.js";

/**
 * Integration test for the Phase 1.3 scheduled assertion (§4.1, §6).
 *
 * `price_composite_btc` was redefined 2026-09-10 (registry v2) from a direct
 * composite over a real `TAOBTC` market pair to an *implied* cross-rate —
 * `price_composite_usd ÷ reference_btc_usd` — because no reputable exchange
 * turned out to list a real TAO/BTC pair at all (see the registry's
 * changelog). That retires this check's original purpose: it used to compare
 * an independently-observed TAO/BTC price against the implied ratio and flag
 * a real divergence between them; now `price_composite_btc` *is* that ratio
 * by construction, so `checkCrossRateDivergence` can never find anything to
 * flag, for any input. This test locks in both halves of that new reality —
 * the derivation is correct, and divergence detection is now a structural
 * no-op — rather than the old "flags a planted drift" behavior, which is no
 * longer possible to produce (there's no more independent value to drift).
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

  it("derives price_composite_btc as the implied ratio, so the check reports no divergences", async () => {
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

    // t=1000: TAO/USD=500, BTC/USD=50000 -> implied TAO/BTC = 0.01.
    // t=2000: TAO/USD=750, BTC/USD=50000 -> implied TAO/BTC = 0.015.
    // No TAOBTC bronze written at all — price_composite_btc no longer reads
    // that pair; it's entirely derived from these two USD-denominated series.
    await writeBronze(
      "TAOUSD",
      `('kraken', 'TAOUSD', 1000, 500, 500, 500, 500, 1, 100, false),
       ('kraken', 'TAOUSD', 2000, 750, 750, 750, 750, 1, 100, false)`,
    );
    await writeBronze(
      "BTCUSD",
      `('kraken', 'BTCUSD', 1000, 50000, 50000, 50000, 50000, 1, 100, false),
       ('kraken', 'BTCUSD', 2000, 50000, 50000, 50000, 50000, 1, 100, false)`,
    );

    await materializeSilverOhlcv();
    // materializeGold now runs every registry entry, including
    // transfer_count_daily — this test only exercises the price/BTC
    // path, so an empty-but-correctly-shaped transfers.parquet is enough to
    // not fail on a missing silver_transfers view.
    await withDuckDb(async (connection) => {
      const silverDir = join(tempRoot, "data", "silver");
      mkdirSync(silverDir, { recursive: true });
      await connection.run(`
        CREATE TABLE transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(
        `COPY transfers TO '${join(silverDir, "transfers.parquet").replace(/\\/g, "/")}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
      );
    });
    await materializeGold(REGISTRY_PATH);

    const impliedRows = await withDuckDb(async (connection) => {
      const result = await connection.run(
        `SELECT timestamp_ms, value FROM read_parquet('${join(goldDir(), "price_composite_btc.parquet").replace(/\\/g, "/")}') ORDER BY timestamp_ms;`,
      );
      return result.getRows();
    });
    expect(impliedRows.map((r) => [Number(r[0]), Number(r[1])])).toEqual([
      [1000, 0.01],
      [2000, 0.015],
    ]);

    // Tautological now by construction — see the describe block's comment.
    const { divergences } = await runCrossRateCheck();
    expect(divergences).toEqual([]);
  });
});

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { materializeSilverOhlcv } from "../src/silver/materializeOhlcv.js";
import { materializeGold } from "../src/gold/materialize.js";
import { writeGoldExport } from "../src/export/writeGoldExport.js";

/**
 * Golden-file test (tao-analytics-plan.md §5): runs the real pipeline
 * (bronze -> silver -> gold -> export) against a small fixture bronze file
 * and asserts gold.json matches a committed golden file. This is the
 * enforcement mechanism for §8's versioning rule — changing the metric's
 * SQL without bumping its version breaks this test, and the only fix is to
 * update the golden file, which is the code-review signal to check the bump.
 */
describe("gold.json golden file", () => {
  const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");
  const GOLDEN_PATH = join(import.meta.dirname, "..", "..", "..", "fixtures", "gold", "gold.golden.json");

  let tempRoot: string;
  let prevDataRoot: string | undefined;
  let prevBronzeUri: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-gold-golden-"));
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

  /**
   * Writes silver/transfers.parquet directly, skipping bronze and the SCALE
   * decode step (that path is covered by decodeEvents' own tests) — this
   * test is about registry/materialize wiring, and `transfer_count_daily`
   * is now part of the real registry every `materializeGold(REGISTRY_PATH)`
   * call here exercises, so it needs *some* silver_transfers input to not
   * fail on a missing view.
   */
  function writeFixtureTransfersSilver(): Promise<void> {
    const silverDir = join(tempRoot, "data", "silver");
    mkdirSync(silverDir, { recursive: true });
    const file = join(silverDir, "transfers.parquet").replace(/\\/g, "/");
    return withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        INSERT INTO transfers VALUES
          (1, 0, 1770000000000, '5Alice', '5Bob',   1000000000),
          (1, 1, 1770000000000, '5Bob',   '5Carol',  500000000),
          (2, 0, 1770000060000, '5Carol', '5Alice',  200000000);
      `);
      await connection.run(`COPY transfers TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
    });
  }

  it("matches the committed golden file for a small fixture bronze input", async () => {
    const bronzeDir = join(tempRoot, "data", "bronze", "prices", "kraken", "TAOUSD");
    mkdirSync(bronzeDir, { recursive: true });
    const bronzeFile = join(bronzeDir, "2026-08.parquet").replace(/\\/g, "/");

    await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE staged (
          exchange VARCHAR, pair VARCHAR, timestamp_ms BIGINT,
          open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
          base_volume DOUBLE, quote_volume DOUBLE, is_partial BOOLEAN
        );
      `);
      await connection.run(`
        INSERT INTO staged VALUES
          ('kraken', 'TAOUSD', 1770000000000, 200, 200, 200, 200, 5,   1000, false),
          ('kraken', 'TAOUSD', 1770000060000, 202, 202, 202, 202, 4,    800, false),
          ('kraken', 'TAOUSD', 1770000120000, 202, 202, 202, 202, 0,      0, false),
          ('kraken', 'TAOUSD', 1770000180000, 198, 198, 198, 198, 2.5,  500, false);
      `);
      await connection.run(`COPY staged TO '${bronzeFile}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
    });

    await materializeSilverOhlcv();
    await writeFixtureTransfersSilver();
    await materializeGold(REGISTRY_PATH);
    const { destination } = await writeGoldExport(REGISTRY_PATH);

    const actual = JSON.parse(readFileSync(destination, "utf-8"));
    delete actual.generatedAt; // volatile — not part of the snapshot

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));
    expect(actual).toEqual(golden);
  });

  it("never exposes a column named 'address' in silver or gold (§3, §7.1)", async () => {
    const bronzeDir = join(tempRoot, "data", "bronze", "prices", "kraken", "TAOUSD");
    mkdirSync(bronzeDir, { recursive: true });
    const bronzeFile = join(bronzeDir, "2026-08.parquet").replace(/\\/g, "/");

    await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE staged (
          exchange VARCHAR, pair VARCHAR, timestamp_ms BIGINT,
          open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
          base_volume DOUBLE, quote_volume DOUBLE, is_partial BOOLEAN
        );
      `);
      await connection.run(
        `INSERT INTO staged VALUES ('kraken', 'TAOUSD', 1770000000000, 200, 200, 200, 200, 5, 1000, false);`,
      );
      await connection.run(`COPY staged TO '${bronzeFile}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
    });

    await materializeSilverOhlcv();
    await writeFixtureTransfersSilver();
    const goldResults = await materializeGold(REGISTRY_PATH);

    const silverPath = join(tempRoot, "data", "silver", "ohlcv_1m.parquet").replace(/\\/g, "/");
    const columnNames = await withDuckDb(async (connection) => {
      const names: string[] = [];
      const silverDesc = await connection.run(`DESCRIBE SELECT * FROM read_parquet('${silverPath}');`);
      for (const row of await silverDesc.getRows()) names.push(String(row[0]));
      for (const g of goldResults) {
        const goldDesc = await connection.run(
          `DESCRIBE SELECT * FROM read_parquet('${g.destination.replace(/\\/g, "/")}');`,
        );
        for (const row of await goldDesc.getRows()) names.push(String(row[0]));
      }
      return names;
    });

    expect(columnNames).not.toContain("address");
  });
});

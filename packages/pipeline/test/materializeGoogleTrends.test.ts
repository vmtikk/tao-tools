import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDuckDb } from "../src/duckdb/session.js";
import { materializeSilverGoogleTrends } from "../src/silver/materializeGoogleTrends.js";

describe("materializeSilverGoogleTrends", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;
  let prevBronzeUri: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-trends-silver-"));
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

  function writeBronzeFetch(keyword: string, fetchDate: string, fetchedAtMs: number, points: [number, number][]): Promise<void> {
    const dir = join(tempRoot, "data", "bronze", "social", "google_trends", keyword);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${fetchDate}.parquet`).replace(/\\/g, "/");
    return withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE fetch_data (keyword VARCHAR, week_start_ms BIGINT, value DOUBLE, is_partial BOOLEAN, fetched_at_ms BIGINT);
      `);
      for (const [weekStartMs, value] of points) {
        await connection.run(
          `INSERT INTO fetch_data VALUES ('${keyword}', ${weekStartMs}, ${value}, false, ${fetchedAtMs});`,
        );
      }
      await connection.run(`COPY fetch_data TO '${file}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
    });
  }

  it("returns null when no Trends bronze exists yet", async () => {
    await expect(materializeSilverGoogleTrends()).resolves.toBeNull();
  });

  it("keeps only the most recently fetched series per keyword, discarding older re-normalizations", async () => {
    await writeBronzeFetch("bittensor", "2026-09-01", 1_000, [
      [0, 10],
      [604800000, 12],
    ]);
    await writeBronzeFetch("bittensor", "2026-09-08", 2_000, [
      [0, 8], // re-normalized against a new peak — different from the first fetch's 10
      [604800000, 11],
      [1209600000, 15],
    ]);

    const result = await materializeSilverGoogleTrends();
    expect(result?.rowCount).toBe(3);

    const rows = await withDuckDb(async (connection) => {
      const r = await connection.run(
        `SELECT week_start_ms, value, fetched_at_ms FROM read_parquet('${result!.destination.replace(/\\/g, "/")}') ORDER BY week_start_ms;`,
      );
      return r.getRows();
    });
    expect(rows.map((r) => [Number(r[0]), Number(r[1]), Number(r[2])])).toEqual([
      [0, 8, 2000],
      [604800000, 11, 2000],
      [1209600000, 15, 2000],
    ]);
  });

  it("keeps each keyword's own latest fetch independently", async () => {
    await writeBronzeFetch("bittensor", "2026-09-08", 2_000, [[0, 8]]);
    await writeBronzeFetch("tao-crypto", "2026-09-01", 1_500, [[0, 40]]);

    const result = await materializeSilverGoogleTrends();
    expect(result?.rowCount).toBe(2);

    const rows = await withDuckDb(async (connection) => {
      const r = await connection.run(
        `SELECT keyword, value FROM read_parquet('${result!.destination.replace(/\\/g, "/")}') ORDER BY keyword;`,
      );
      return r.getRows();
    });
    expect(rows.map((r) => [String(r[0]), Number(r[1])])).toEqual([
      ["bittensor", 8],
      ["tao-crypto", 40],
    ]);
  });
});

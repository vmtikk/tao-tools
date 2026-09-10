import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Ohlcv } from "@tao-tools/core";
import { asUnixMillis } from "@tao-tools/core";
import { writeOhlcBronze } from "../src/bronze/writer.js";

function candle(timestampMs: number, close: number): Ohlcv {
  return {
    exchange: "kraken",
    pair: "TAOUSD",
    timestampMs: asUnixMillis(timestampMs),
    open: close,
    high: close,
    low: close,
    close,
    baseVolume: 1,
    quoteVolume: close,
    isPartial: false,
  };
}

describe("writeOhlcBronze", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-price-writer-")).replace(/\\/g, "/");
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function readBack(destination: string): Promise<{ timestampMs: number }[]> {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const result = await connection.run(`SELECT timestamp_ms FROM read_parquet('${destination}') ORDER BY timestamp_ms;`);
      return (await result.getRows()).map((r) => ({ timestampMs: Number(r[0]) }));
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  it("writes a brand-new month as-is", async () => {
    const result = await writeOhlcBronze({
      rows: [candle(0, 100), candle(60_000, 101)],
      exchange: "kraken",
      pair: "TAOUSD",
      month: "2026-01",
      bronzeUri: tempRoot,
    });
    expect(result.rowCount).toBe(2);
    const rows = await readBack(result.destination);
    expect(rows.map((r) => r.timestampMs)).toEqual([0, 60_000]);
  });

  /**
   * Regression test for the real 2026-09-10 bug: `runResumableVenueBackfill`
   * only ever buffers rows fetched *during the current run*, so the month
   * containing "now" gets revisited across every future resumed run. A
   * second write used to be a plain overwrite, discarding everything an
   * earlier run had already written for that month and keeping only the
   * latest small increment (binance's current-month bronze file shrank from
   * what should have been ~800KB down to 2.3KB after a second run).
   */
  it("merges with an existing month instead of overwriting it", async () => {
    const opts = { exchange: "kraken", pair: "TAOUSD", month: "2026-01", bronzeUri: tempRoot };

    const first = await writeOhlcBronze({ ...opts, rows: [candle(0, 100), candle(60_000, 101), candle(120_000, 102)] });
    expect(first.rowCount).toBe(3);

    // Simulates a resumed run that only fetched the newest few candles.
    const second = await writeOhlcBronze({ ...opts, rows: [candle(180_000, 103)] });

    // Merged total, not just the second run's 1 new row.
    expect(second.rowCount).toBe(4);
    const rows = await readBack(second.destination);
    expect(rows.map((r) => r.timestampMs)).toEqual([0, 60_000, 120_000, 180_000]);
  });

  it("deduplicates by timestamp_ms instead of double-counting an overlapping candle", async () => {
    const opts = { exchange: "kraken", pair: "TAOUSD", month: "2026-01", bronzeUri: tempRoot };

    await writeOhlcBronze({ ...opts, rows: [candle(0, 100), candle(60_000, 101)] });
    // Re-fetched 60_000 (overlap) plus one genuinely new candle.
    const second = await writeOhlcBronze({ ...opts, rows: [candle(60_000, 999), candle(120_000, 102)] });

    expect(second.rowCount).toBe(3); // not 4
    const rows = await readBack(second.destination);
    expect(rows.map((r) => r.timestampMs)).toEqual([0, 60_000, 120_000]);
  });

  it("keeps each month's file independent", async () => {
    const jan = await writeOhlcBronze({
      rows: [candle(0, 100)],
      exchange: "kraken",
      pair: "TAOUSD",
      month: "2026-01",
      bronzeUri: tempRoot,
    });
    const feb = await writeOhlcBronze({
      rows: [candle(0, 200)],
      exchange: "kraken",
      pair: "TAOUSD",
      month: "2026-02",
      bronzeUri: tempRoot,
    });
    expect(jan.destination).not.toBe(feb.destination);
    expect((await readBack(jan.destination)).length).toBe(1);
    expect((await readBack(feb.destination)).length).toBe(1);
  });
});

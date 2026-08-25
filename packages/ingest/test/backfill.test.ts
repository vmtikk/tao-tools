import { describe, expect, it } from "vitest";
import type { OHLCV } from "ccxt";
import { asUnixMillis } from "@tao-tools/core";
import { groupOhlcvByMonth, paginateOhlcv } from "../src/exchanges/backfill.js";

const ONE_MIN = 60_000;

function candle(tsMs: number, close: number): OHLCV {
  return [tsMs, close, close, close, close, 1];
}

describe("paginateOhlcv (unit — orchestration over an injected fetchPage)", () => {
  it("stops once it catches up to the live edge", async () => {
    const nowMs = asUnixMillis(5 * ONE_MIN);
    let calls = 0;
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 3,
      nowMs,
      fetchPage: async (sinceMs) => {
        calls++;
        // Each page returns up to 3 candles starting at sinceMs, capped at "now".
        const candles: OHLCV[] = [];
        for (let t = sinceMs; t < sinceMs + 3 * ONE_MIN && t <= nowMs; t += ONE_MIN) {
          candles.push(candle(t, 100));
        }
        return candles;
      },
    });

    expect(rows.map((r) => r.timestampMs)).toEqual([0, ONE_MIN, 2 * ONE_MIN, 3 * ONE_MIN, 4 * ONE_MIN, 5 * ONE_MIN]);
    expect(calls).toBe(2);
  });

  it("stops when the venue returns fewer candles than requested (history exhausted)", async () => {
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 10,
      nowMs: asUnixMillis(1_000 * ONE_MIN),
      fetchPage: async () => [candle(0, 100), candle(ONE_MIN, 101)], // 2 < limit(10)
    });
    expect(rows).toHaveLength(2);
  });

  it("stops immediately when a page comes back empty", async () => {
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      nowMs: asUnixMillis(1_000 * ONE_MIN),
      fetchPage: async () => [],
    });
    expect(rows).toEqual([]);
  });

  it("does not loop forever when a venue keeps returning the same stale page", async () => {
    let calls = 0;
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 5,
      nowMs: asUnixMillis(1_000 * ONE_MIN),
      fetchPage: async () => {
        calls++;
        return [candle(0, 100)]; // same single candle forever, no progress
      },
    });
    expect(rows).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("respects maxPages as a hard safety cap", async () => {
    let calls = 0;
    await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 1,
      maxPages: 3,
      nowMs: asUnixMillis(1_000_000 * ONE_MIN),
      fetchPage: async (sinceMs) => {
        calls++;
        return [candle(sinceMs, 100)]; // always makes forward progress, never exhausts
      },
    });
    expect(calls).toBe(3);
  });
});

describe("groupOhlcvByMonth", () => {
  it("buckets rows by yyyy-mm", () => {
    const rows = [
      { timestampMs: Date.UTC(2026, 0, 15), exchange: "k", pair: "TAOUSD", open: 1, high: 1, low: 1, close: 1, baseVolume: 1, quoteVolume: 1, isPartial: false },
      { timestampMs: Date.UTC(2026, 0, 20), exchange: "k", pair: "TAOUSD", open: 1, high: 1, low: 1, close: 1, baseVolume: 1, quoteVolume: 1, isPartial: false },
      { timestampMs: Date.UTC(2026, 1, 1), exchange: "k", pair: "TAOUSD", open: 1, high: 1, low: 1, close: 1, baseVolume: 1, quoteVolume: 1, isPartial: false },
    ] as const;
    const byMonth = groupOhlcvByMonth(rows as unknown as Parameters<typeof groupOhlcvByMonth>[0]);
    expect([...byMonth.keys()]).toEqual(["2026-01", "2026-02"]);
    expect(byMonth.get("2026-01")).toHaveLength(2);
    expect(byMonth.get("2026-02")).toHaveLength(1);
  });
});

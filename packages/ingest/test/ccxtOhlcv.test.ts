import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OHLCV } from "ccxt";
import { fetchCcxtOhlcv, normalizeCcxtOhlcv, type OhlcvFetcher } from "../src/exchanges/ccxtOhlcv.js";
import { ALL_VENUES } from "../src/exchanges/venues.js";

const FIXTURE_PATH = join(import.meta.dirname, "..", "..", "..", "fixtures", "ccxt", "ohlcv_sample.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as OHLCV[];

describe("normalizeCcxtOhlcv (unit — ccxt candle tuple -> Ohlcv)", () => {
  it("maps every candle to an Ohlcv with quoteVolume derived from close", () => {
    const rows = normalizeCcxtOhlcv(fixture, { exchange: "kraken", pair: "TAOUSD", nowMs: 9_999_999_999 as never });
    expect(rows).toHaveLength(5);
    const traded = rows[3]!;
    expect(traded).toMatchObject({
      exchange: "kraken",
      pair: "TAOUSD",
      open: 234.8149,
      high: 235.1301,
      low: 234.8149,
      close: 235.1301,
      baseVolume: 3.33369,
    });
    expect(traded.quoteVolume).toBeCloseTo(3.33369 * 235.1301, 6);
  });

  it("treats a zero-volume filler candle as zero quote volume, not a gap", () => {
    const rows = normalizeCcxtOhlcv(fixture, { exchange: "kraken", pair: "TAOUSD", nowMs: 9_999_999_999 as never });
    expect(rows[0]!.baseVolume).toBe(0);
    expect(rows[0]!.quoteVolume).toBe(0);
  });

  it("marks only the final, still-forming candle as partial", () => {
    const lastCandleStartMs = 1787680500000;
    const nowMs = (lastCandleStartMs + 30_000) as never; // 30s into the last 1m bucket
    const rows = normalizeCcxtOhlcv(fixture, { exchange: "kraken", pair: "TAOUSD", intervalMinutes: 1, nowMs });
    expect(rows.slice(0, -1).every((r) => !r.isPartial)).toBe(true);
    expect(rows.at(-1)!.isPartial).toBe(true);
  });

  it("marks no candle partial once every bucket has closed", () => {
    const nowMs = (1787680500000 + 120_000) as never;
    const rows = normalizeCcxtOhlcv(fixture, { exchange: "kraken", pair: "TAOUSD", intervalMinutes: 1, nowMs });
    expect(rows.every((r) => !r.isPartial)).toBe(true);
  });

  it("throws when a candle is missing a required OHLC field", () => {
    const malformed: OHLCV[] = [[1_000, undefined, 1, 1, 1, 1]];
    expect(() => normalizeCcxtOhlcv(malformed, { exchange: "kraken", pair: "TAOUSD" })).toThrow(/missing a required field/i);
  });
});

describe("fetchCcxtOhlcv (contract — injected fetcher)", () => {
  it("passes timeframe/since/limit through to the exchange and returns its candles", async () => {
    let seenArgs: unknown[] = [];
    const fetcher: OhlcvFetcher = {
      fetchOHLCV: async (...args) => {
        seenArgs = args;
        return fixture;
      },
    };
    const result = await fetchCcxtOhlcv({
      exchangeId: "kraken",
      symbol: "TAO/USD",
      intervalMinutes: 1,
      sinceMs: 1787680000000,
      limit: 720,
      fetcher,
    });
    expect(result).toEqual(fixture);
    expect(seenArgs).toEqual(["TAO/USD", "1m", 1787680000000, 720]);
  });

  it("propagates a rate-limit rejection rather than swallowing it", async () => {
    const fetcher: OhlcvFetcher = {
      fetchOHLCV: async () => {
        throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
      },
    };
    await expect(fetchCcxtOhlcv({ exchangeId: "kraken", symbol: "TAO/USD", fetcher })).rejects.toThrow(/429/);
  });

  it("throws for an unconfigured ccxt exchange id when no fetcher is injected", async () => {
    await expect(fetchCcxtOhlcv({ exchangeId: "not-a-real-exchange", symbol: "TAO/USD" })).rejects.toThrow(
      /unknown ccxt exchange id/i,
    );
  });
});

/**
 * Every venue in the registry gets its own contract-test run (§5, Tier 3:
 * "one contract test each" — §6 Phase 1.1). ccxt normalizes every venue to
 * the identical OHLCV tuple shape, so the per-venue risk this guards against
 * is config wiring (the right ccxt exchange id and symbol land on the right
 * bronze exchange/pair label), not response parsing — one shared fixture
 * replayed through each venue's own config is representative of that risk.
 */
describe.each(ALL_VENUES)("venue contract: $exchange $pair", (venue) => {
  it("fetches through the configured ccxt id/symbol and normalizes onto the venue's own labels", async () => {
    let seenSymbol: string | undefined;
    const fetcher: OhlcvFetcher = {
      fetchOHLCV: async (symbol) => {
        seenSymbol = symbol;
        return fixture;
      },
    };
    const raw = await fetchCcxtOhlcv({ exchangeId: venue.ccxtExchangeId, symbol: venue.ccxtSymbol, fetcher });
    expect(seenSymbol).toBe(venue.ccxtSymbol);

    const rows = normalizeCcxtOhlcv(raw, { exchange: venue.exchange, pair: venue.pair, nowMs: 9_999_999_999 as never });
    expect(rows).toHaveLength(fixture.length);
    expect(rows.every((r) => r.exchange === venue.exchange && r.pair === venue.pair)).toBe(true);
  });
});

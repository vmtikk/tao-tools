import { describe, expect, it } from "vitest";
import { ALL_VENUES, BTC_VENUES, REFERENCE_VENUES, USDT_VENUES, USD_VENUES } from "../src/exchanges/venues.js";

describe("venue registry", () => {
  it("has no duplicate exchange+pair combination", () => {
    const keys = ALL_VENUES.map((v) => `${v.exchange}:${v.pair}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the trimmed venue list (2026-09-10, after a real backfill run found several non-functional)", () => {
    expect(USD_VENUES.map((v) => v.exchange).sort()).toEqual(["coinbase", "kraken"]);
    // Bybit (no TAO/USDT market under ccxt) and Gate.io (hard 7-day history
    // cap, can't backfill) were dropped — see venues.ts's doc comment.
    expect(USDT_VENUES.map((v) => v.exchange).sort()).toEqual(["binance", "mexc", "okx"]);
    // Empty: both plan-listed BTC venues turned out non-functional (Kraken
    // has no TAO/BTC market; Upbit returns 0 candles). price_composite_btc
    // has no data source until a real replacement venue is found.
    expect(BTC_VENUES).toEqual([]);
  });

  it("has reference BTC venues for the cross-rate check, including a deep-history one", () => {
    // Kraken's BTC/USD is thin (live-tail only, same limitation as its TAO
    // pairs); Binance's BTC/USDT has real deep history and is what the
    // cross-rate check can actually validate against pre-2025 data with.
    expect(REFERENCE_VENUES.map((v) => `${v.exchange}:${v.pair}`).sort()).toEqual([
      "binance:BTCUSDT",
      "kraken:BTCUSD",
    ]);
  });

  it("ALL_VENUES is the union of every group", () => {
    expect(ALL_VENUES).toHaveLength(USD_VENUES.length + USDT_VENUES.length + BTC_VENUES.length + REFERENCE_VENUES.length);
  });
});

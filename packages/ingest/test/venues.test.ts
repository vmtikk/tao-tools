import { describe, expect, it } from "vitest";
import { ALL_VENUES, BTC_VENUES, REFERENCE_VENUES, USDT_VENUES, USD_VENUES } from "../src/exchanges/venues.js";

describe("venue registry", () => {
  it("has no duplicate exchange+pair combination", () => {
    const keys = ALL_VENUES.map((v) => `${v.exchange}:${v.pair}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("matches the plan's §4.1 venue table", () => {
    expect(USD_VENUES.map((v) => v.exchange).sort()).toEqual(["coinbase", "kraken"]);
    expect(USDT_VENUES.map((v) => v.exchange).sort()).toEqual(["binance", "bybit", "gate", "mexc", "okx"]);
    expect(BTC_VENUES.map((v) => v.exchange).sort()).toEqual(["kraken", "upbit"]);
  });

  it("has a reference BTC/USD venue for the cross-rate check", () => {
    expect(REFERENCE_VENUES).toHaveLength(1);
    expect(REFERENCE_VENUES[0]).toMatchObject({ pair: "BTCUSD" });
  });

  it("ALL_VENUES is the union of every group", () => {
    expect(ALL_VENUES).toHaveLength(USD_VENUES.length + USDT_VENUES.length + BTC_VENUES.length + REFERENCE_VENUES.length);
  });
});

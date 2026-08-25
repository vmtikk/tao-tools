import { describe, expect, it } from "vitest";
import { computeVolumeWeightedComposite } from "../src/composite.js";
import { asUnixMillis } from "../src/types/brands.js";

describe("computeVolumeWeightedComposite", () => {
  it("passes through a single venue (composite-of-one)", () => {
    const result = computeVolumeWeightedComposite([
      { exchange: "kraken", close: 500, quoteVolume: 1000, timestampMs: asUnixMillis(0) },
    ]);
    expect(result).toEqual({ price: 500, venuesUsed: ["kraken"] });
  });

  it("weights multiple venues by quote volume", () => {
    const result = computeVolumeWeightedComposite([
      { exchange: "kraken", close: 500, quoteVolume: 300, timestampMs: asUnixMillis(0) },
      { exchange: "coinbase", close: 510, quoteVolume: 100, timestampMs: asUnixMillis(0) },
    ]);
    // (500*300 + 510*100) / 400 = 502.5
    expect(result?.price).toBeCloseTo(502.5, 10);
    expect(result?.venuesUsed).toEqual(["kraken", "coinbase"]);
  });

  it("returns null when volume is zero across all venues", () => {
    const result = computeVolumeWeightedComposite([
      { exchange: "kraken", close: 500, quoteVolume: 0, timestampMs: asUnixMillis(0) },
      { exchange: "coinbase", close: 510, quoteVolume: 0, timestampMs: asUnixMillis(0) },
    ]);
    expect(result).toBeNull();
  });

  it("returns null when given no venues", () => {
    expect(computeVolumeWeightedComposite([])).toBeNull();
  });

  it("excludes a stale venue rather than silently weighting it", () => {
    const asOfMs = asUnixMillis(100_000);
    const result = computeVolumeWeightedComposite(
      [
        { exchange: "kraken", close: 500, quoteVolume: 100, timestampMs: asUnixMillis(99_000) },
        { exchange: "coinbase", close: 900, quoteVolume: 100, timestampMs: asUnixMillis(0) },
      ],
      { staleAfterMs: 5_000, asOfMs },
    );
    expect(result).toEqual({ price: 500, venuesUsed: ["kraken"] });
  });

  it("returns null when every venue is stale", () => {
    const asOfMs = asUnixMillis(100_000);
    const result = computeVolumeWeightedComposite(
      [{ exchange: "kraken", close: 500, quoteVolume: 100, timestampMs: asUnixMillis(0) }],
      { staleAfterMs: 5_000, asOfMs },
    );
    expect(result).toBeNull();
  });
});

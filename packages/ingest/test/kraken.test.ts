import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchKrakenOhlc, normalizeKrakenOhlc, type KrakenOhlcResponse } from "../src/exchanges/kraken.js";

const FIXTURE_PATH = join(import.meta.dirname, "..", "..", "..", "fixtures", "kraken", "ohlc_TAOUSD_sample.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as KrakenOhlcResponse;

describe("normalizeKrakenOhlc (unit — array shape -> Ohlcv)", () => {
  it("maps every row to an Ohlcv with derived quote volume", () => {
    const rows = normalizeKrakenOhlc(fixture, { pair: "TAOUSD", nowMs: 9_999_999_999 as never });
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
    // quoteVolume = baseVolume * vwap = 3.33369 * 235.1285
    expect(traded.quoteVolume).toBeCloseTo(3.33369 * 235.1285, 6);
  });

  it("treats a zero-volume filler candle as zero quote volume, not a gap", () => {
    const rows = normalizeKrakenOhlc(fixture, { pair: "TAOUSD", nowMs: 9_999_999_999 as never });
    expect(rows[0]!.baseVolume).toBe(0);
    expect(rows[0]!.quoteVolume).toBe(0);
  });

  it("marks only the final, still-forming candle as partial", () => {
    const lastCandleStartSeconds = 1787680500;
    const nowMs = ((lastCandleStartSeconds + 30) * 1000) as never; // 30s into the last 1m bucket
    const rows = normalizeKrakenOhlc(fixture, { pair: "TAOUSD", intervalMinutes: 1, nowMs });
    expect(rows.slice(0, -1).every((r) => !r.isPartial)).toBe(true);
    expect(rows.at(-1)!.isPartial).toBe(true);
  });

  it("marks no candle partial once every bucket has closed", () => {
    const nowMs = ((1787680500 + 120) * 1000) as never; // 2 minutes after the last bucket started
    const rows = normalizeKrakenOhlc(fixture, { pair: "TAOUSD", intervalMinutes: 1, nowMs });
    expect(rows.every((r) => !r.isPartial)).toBe(true);
  });

  it("throws when the response carries no candle rows for the pair", () => {
    expect(() => normalizeKrakenOhlc({ error: [], result: { last: 0 } }, { pair: "TAOUSD" })).toThrow(
      /no candle rows/i,
    );
  });
});

describe("fetchKrakenOhlc (contract — recorded fixture)", () => {
  it("parses a recorded 200 response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fixture), { status: 200 })) as unknown as typeof fetch;
    const result = await fetchKrakenOhlc({ pair: "TAOUSD", fetchImpl });
    expect(result.result.TAOUSD).toHaveLength(5);
  });

  it("throws on a non-ok HTTP status", async () => {
    const fetchImpl = (async () =>
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" })) as unknown as typeof fetch;
    await expect(fetchKrakenOhlc({ pair: "TAOUSD", fetchImpl })).rejects.toThrow(/429/);
  });

  it("throws when Kraken reports an error in the body", async () => {
    const body: KrakenOhlcResponse = { error: ["EQuery:Unknown asset pair"], result: {} };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchKrakenOhlc({ pair: "NOPE", fetchImpl })).rejects.toThrow(/Unknown asset pair/);
  });
});

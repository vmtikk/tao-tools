import { asUnixMillis, type Ohlcv, type UnixMillis } from "@tao-tools/core";

const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";

/** One raw Kraken OHLC row: [time, open, high, low, close, vwap, volume, count]. */
export type KrakenOhlcRow = [number, string, string, string, string, string, string, number];

export interface KrakenOhlcResponse {
  error: string[];
  result: Record<string, KrakenOhlcRow[] | number>;
}

export interface FetchKrakenOhlcOptions {
  pair: string;
  /** 1-minute candles for Phase 0/1 (tao-analytics-plan.md §4.1). */
  intervalMinutes?: number;
  /** Unix seconds; return candles since this time. */
  sinceSeconds?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetches raw Kraken OHLC candles. No normalization here — that is a
 * separate pure function so it can be unit tested without a network call
 * (tao-analytics-plan.md §5, Tier 1: "Kline normalization").
 */
export async function fetchKrakenOhlc(opts: FetchKrakenOhlcOptions): Promise<KrakenOhlcResponse> {
  const { pair, intervalMinutes = 1, sinceSeconds, fetchImpl = fetch } = opts;
  const url = new URL(KRAKEN_OHLC_URL);
  url.searchParams.set("pair", pair);
  url.searchParams.set("interval", String(intervalMinutes));
  if (sinceSeconds !== undefined) {
    url.searchParams.set("since", String(sinceSeconds));
  }

  const res = await fetchImpl(url.toString());
  if (!res.ok) {
    throw new Error(`Kraken OHLC request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as KrakenOhlcResponse;
  if (body.error.length > 0) {
    throw new Error(`Kraken OHLC error: ${body.error.join(", ")}`);
  }
  return body;
}

export interface NormalizeKrakenOhlcOptions {
  exchange?: string;
  pair: string;
  intervalMinutes?: number;
  /** Candles whose bucket hasn't closed by this time are marked partial. */
  nowMs?: UnixMillis;
}

/**
 * Pure array-shape → Ohlcv[] parse. Kraken quotes volume in the base asset
 * plus a vwap, so quote volume — what the composite weights by (§4.1) — is
 * derived as baseVolume * vwap, not read directly off the wire.
 */
export function normalizeKrakenOhlc(
  response: KrakenOhlcResponse,
  opts: NormalizeKrakenOhlcOptions,
): Ohlcv[] {
  const { exchange = "kraken", pair, intervalMinutes = 1, nowMs = asUnixMillis(Date.now()) } = opts;

  const rows = Object.entries(response.result).find(([key]) => key !== "last")?.[1];
  if (!rows || !Array.isArray(rows)) {
    throw new Error(`Kraken OHLC response has no candle rows for pair "${pair}"`);
  }

  const intervalMs = intervalMinutes * 60_000;

  return rows.map((row) => {
    const [timeSeconds, open, high, low, close, vwap, volume] = row;
    const timestampMs = asUnixMillis(timeSeconds * 1000);
    const baseVolume = Number(volume);
    const quoteVolume = baseVolume * Number(vwap);
    const bucketEndMs = timestampMs + intervalMs;

    return {
      exchange,
      pair,
      timestampMs,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      baseVolume,
      quoteVolume,
      isPartial: bucketEndMs > nowMs,
    } satisfies Ohlcv;
  });
}

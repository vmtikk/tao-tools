import ccxt, { type Exchange, type OHLCV } from "ccxt";
import { asUnixMillis, type Ohlcv, type UnixMillis } from "@tao-tools/core";

/** The slice of ccxt's `Exchange` this module actually calls — narrowed so
 * contract tests can inject a fixture-backed fake instead of a real venue. */
export interface OhlcvFetcher {
  fetchOHLCV(symbol: string, timeframe?: string, since?: number, limit?: number): Promise<OHLCV[]>;
}

const exchangeCache = new Map<string, Exchange>();

/** ccxt exports every exchange class by id on the default export (§2 stack —
 * ccxt is TypeScript-native and normalizes venue quirks). One instance per
 * id is reused across calls so ccxt's built-in rate limiter tracks state
 * correctly instead of resetting on every fetch. */
function getExchange(exchangeId: string): Exchange {
  let instance = exchangeCache.get(exchangeId);
  if (instance) return instance;

  const registry = ccxt as unknown as Record<string, new (config?: Record<string, unknown>) => Exchange>;
  const ExchangeCtor = registry[exchangeId];
  if (!ExchangeCtor) {
    throw new Error(`Unknown ccxt exchange id "${exchangeId}"`);
  }
  instance = new ExchangeCtor({ enableRateLimit: true });
  exchangeCache.set(exchangeId, instance);
  return instance;
}

export interface FetchCcxtOhlcvOptions {
  exchangeId: string;
  /** ccxt unified symbol, e.g. "TAO/USD". */
  symbol: string;
  intervalMinutes?: number;
  /** Unix milliseconds; return candles since this time. */
  sinceMs?: number;
  limit?: number;
  /** Injectable for contract tests — bypasses the network entirely. */
  fetcher?: OhlcvFetcher;
}

/**
 * Fetches raw OHLCV candles through ccxt. No normalization here — kept
 * separate so normalization is unit-testable without a network call
 * (tao-analytics-plan.md §5, Tier 1: "Kline normalization").
 */
export async function fetchCcxtOhlcv(opts: FetchCcxtOhlcvOptions): Promise<OHLCV[]> {
  const { exchangeId, symbol, intervalMinutes = 1, sinceMs, limit, fetcher } = opts;
  const timeframe = `${intervalMinutes}m`;
  const impl = fetcher ?? getExchange(exchangeId);
  return impl.fetchOHLCV(symbol, timeframe, sinceMs, limit);
}

export interface NormalizeCcxtOhlcvOptions {
  exchange: string;
  pair: string;
  intervalMinutes?: number;
  /** Candles whose bucket hasn't closed by this time are marked partial. */
  nowMs?: UnixMillis;
}

/**
 * Pure ccxt-candle-tuple -> Ohlcv[] parse. ccxt's unified OHLCV volume field
 * is base-asset volume (it does not expose a per-bucket vwap the way
 * Kraken's native REST endpoint does), so quote volume — what the composite
 * weights by (§4.1) — is approximated as baseVolume * close.
 */
export function normalizeCcxtOhlcv(candles: readonly OHLCV[], opts: NormalizeCcxtOhlcvOptions): Ohlcv[] {
  const { exchange, pair, intervalMinutes = 1, nowMs = asUnixMillis(Date.now()) } = opts;
  const intervalMs = intervalMinutes * 60_000;

  return candles.map((candle) => {
    const [ts, open, high, low, close, volume] = candle;
    if (ts === undefined || open === undefined || high === undefined || low === undefined || close === undefined) {
      throw new Error(
        `ccxt OHLCV candle for ${exchange} ${pair} is missing a required field: ${JSON.stringify(candle)}`,
      );
    }
    const timestampMs = asUnixMillis(ts);
    const baseVolume = volume ?? 0;
    const bucketEndMs = timestampMs + intervalMs;

    return {
      exchange,
      pair,
      timestampMs,
      open,
      high,
      low,
      close,
      baseVolume,
      quoteVolume: baseVolume * close,
      isPartial: bucketEndMs > nowMs,
    } satisfies Ohlcv;
  });
}

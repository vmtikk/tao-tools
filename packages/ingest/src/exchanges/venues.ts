/**
 * Venue configuration (tao-analytics-plan.md §4.1). Every venue is fetched
 * through ccxt (§2 stack) with its own ccxt exchange id and unified symbol —
 * ccxt normalizes the wire format, so what varies per venue here is just
 * config, not parsing code.
 */
export interface PriceVenue {
  /** Matches Ohlcv.exchange. */
  exchange: string;
  /** Matches Ohlcv.pair — the bronze/silver pair label, not ccxt's symbol. */
  pair: string;
  /** ccxt exchange id, e.g. "kraken". */
  ccxtExchangeId: string;
  /** ccxt unified symbol, e.g. "TAO/USD". */
  ccxtSymbol: string;
}

export const USD_VENUES: PriceVenue[] = [
  { exchange: "kraken", pair: "TAOUSD", ccxtExchangeId: "kraken", ccxtSymbol: "TAO/USD" },
  { exchange: "coinbase", pair: "TAOUSD", ccxtExchangeId: "coinbase", ccxtSymbol: "TAO/USD" },
];

/** Quoted in USDT, treated as USD-equivalent for the composite and volume
 * chart (§4.1) — USDT trades close to 1:1 with USD.
 *
 * Bybit and Gate.io were dropped 2026-09-10 after a real backfill run:
 * Bybit's ccxt market list doesn't have a `TAO/USDT` symbol at all
 * ("bybit does not have market symbol TAO/USDT", confirmed with both an old
 * and a recent `since` — not a history-depth issue, the pair just isn't
 * there under that mapping). Gate.io's public API hard-caps history at
 * "Maximum 10000 points ago" (~7 days at 1-minute resolution) — it cannot
 * contribute to a 2023-onward backfill at all, only a live tail, and wasn't
 * trusted enough to keep for that alone. */
export const USDT_VENUES: PriceVenue[] = [
  { exchange: "binance", pair: "TAOUSDT", ccxtExchangeId: "binance", ccxtSymbol: "TAO/USDT" },
  { exchange: "okx", pair: "TAOUSDT", ccxtExchangeId: "okx", ccxtSymbol: "TAO/USDT" },
  { exchange: "mexc", pair: "TAOUSDT", ccxtExchangeId: "mexc", ccxtSymbol: "TAO/USDT" },
];

/**
 * Empty as of 2026-09-10 — both venues the plan (§4.1) named for TAO/BTC
 * turned out non-functional: Kraken's ccxt market list has no `TAO/BTC`
 * symbol ("kraken does not have market symbol TAO/BTC" — Kraken doesn't
 * list this pair directly, contradicting the plan's assumption), and Upbit
 * returns 0 candles even for a recent `since` with no error (no real
 * listing/liquidity found under that symbol). This means `price_composite_btc`
 * (chart 2) currently has no data source at all — not a regression from
 * this cleanup, just made explicit. Needs a real replacement venue before
 * chart 2 can render anything.
 */
export const BTC_VENUES: PriceVenue[] = [];

/**
 * Feeds the cross-rate sanity check (§4.1, §6 Phase 1.3) as the BTC/USD leg
 * of "TAO/USD ÷ BTC/USD should track TAO/BTC". Not a chart, so a single
 * venue would be acceptable — but Kraken's `BTC/USD` has the exact same
 * live-tail-only limitation as its TAO pairs (confirmed 2026-09-10: a
 * `since=2023-01-01` probe returns candles starting today, not real
 * history). Binance's own `BTC/USD` turned out to be real but only listed
 * since ~2025-12; its `BTC/USDT` has full deep history back to (at least)
 * 2023-01-01, same as its `TAO/USDT` — added here, `pair: "BTCUSDT"`,
 * following the same USDT-as-USD-equivalent treatment `USD_DENOMINATED_PAIRS`
 * already uses for TAO (see `reference_btc_usd`'s registry SQL, widened to
 * match). Kraken is kept too — thin history doesn't hurt anything, and it
 * still contributes real current-day data.
 */
export const REFERENCE_VENUES: PriceVenue[] = [
  { exchange: "kraken", pair: "BTCUSD", ccxtExchangeId: "kraken", ccxtSymbol: "BTC/USD" },
  { exchange: "binance", pair: "BTCUSDT", ccxtExchangeId: "binance", ccxtSymbol: "BTC/USDT" },
];

/** Every venue this backfill/live pipeline touches, in one list. */
export const ALL_VENUES: PriceVenue[] = [...USD_VENUES, ...USDT_VENUES, ...BTC_VENUES, ...REFERENCE_VENUES];

/** Pairs the USD composite and volume chart aggregate across (§4.1: USDT
 * treated as USD-equivalent). */
export const USD_DENOMINATED_PAIRS = ["TAOUSD", "TAOUSDT"];

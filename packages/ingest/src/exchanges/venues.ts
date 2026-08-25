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
 * chart (§4.1) — USDT trades close to 1:1 with USD, and these five venues
 * carry the bulk of TAO's dollar-denominated volume. */
export const USDT_VENUES: PriceVenue[] = [
  { exchange: "binance", pair: "TAOUSDT", ccxtExchangeId: "binance", ccxtSymbol: "TAO/USDT" },
  { exchange: "bybit", pair: "TAOUSDT", ccxtExchangeId: "bybit", ccxtSymbol: "TAO/USDT" },
  { exchange: "okx", pair: "TAOUSDT", ccxtExchangeId: "okx", ccxtSymbol: "TAO/USDT" },
  { exchange: "mexc", pair: "TAOUSDT", ccxtExchangeId: "mexc", ccxtSymbol: "TAO/USDT" },
  { exchange: "gate", pair: "TAOUSDT", ccxtExchangeId: "gate", ccxtSymbol: "TAO/USDT" },
];

export const BTC_VENUES: PriceVenue[] = [
  { exchange: "kraken", pair: "TAOBTC", ccxtExchangeId: "kraken", ccxtSymbol: "TAO/BTC" },
  { exchange: "upbit", pair: "TAOBTC", ccxtExchangeId: "upbit", ccxtSymbol: "TAO/BTC" },
];

/** Not a chart — feeds the cross-rate sanity check (§4.1, §6 Phase 1.3) as
 * the BTC/USD leg of "TAO/USD ÷ BTC/USD should track TAO/BTC". Single venue
 * is fine here: this is a reference input, not a composite chart. */
export const REFERENCE_VENUES: PriceVenue[] = [
  { exchange: "kraken", pair: "BTCUSD", ccxtExchangeId: "kraken", ccxtSymbol: "BTC/USD" },
];

/** Every venue this backfill/live pipeline touches, in one list. */
export const ALL_VENUES: PriceVenue[] = [...USD_VENUES, ...USDT_VENUES, ...BTC_VENUES, ...REFERENCE_VENUES];

/** Pairs the USD composite and volume chart aggregate across (§4.1: USDT
 * treated as USD-equivalent). */
export const USD_DENOMINATED_PAIRS = ["TAOUSD", "TAOUSDT"];

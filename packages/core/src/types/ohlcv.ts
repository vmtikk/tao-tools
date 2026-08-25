import type { UnixMillis } from "./brands.js";

/** One normalized 1-minute candle from a single venue. */
export interface Ohlcv {
  exchange: string;
  pair: string;
  timestampMs: UnixMillis;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume in the base asset (e.g. TAO). */
  baseVolume: number;
  /** Volume in the quote asset (e.g. USD). What the composite weights by. */
  quoteVolume: number;
  /** True when the venue reports this candle as still forming. */
  isPartial: boolean;
}

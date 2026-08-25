import type { UnixMillis } from "./types/brands.js";

/** A single venue's quote for one composite bucket (e.g. one 1-minute candle). */
export interface VenueQuote {
  exchange: string;
  close: number;
  quoteVolume: number;
  timestampMs: UnixMillis;
}

export interface CompositeResult {
  price: number;
  venuesUsed: string[];
}

export interface CompositeOptions {
  /** Exclude a venue whose quote is older than this many ms before `asOfMs`. */
  staleAfterMs?: number;
  asOfMs?: UnixMillis;
}

/**
 * Volume-weighted composite price across venues (tao-analytics-plan.md §4.1,
 * §6 Phase 0). Called with a single venue this is a passthrough by
 * construction, not a special case — n=1 degenerates to that venue's own
 * close because it is the only weight in the sum.
 *
 * Returns null when no venue survives filtering (no venues, all zero
 * volume, or all stale) — callers must not silently substitute zero.
 */
export function computeVolumeWeightedComposite(
  quotes: readonly VenueQuote[],
  opts: CompositeOptions = {},
): CompositeResult | null {
  const { staleAfterMs, asOfMs } = opts;

  const eligible = quotes.filter((q) => {
    if (q.quoteVolume <= 0) return false;
    if (staleAfterMs !== undefined && asOfMs !== undefined) {
      if (asOfMs - q.timestampMs > staleAfterMs) return false;
    }
    return true;
  });

  if (eligible.length === 0) return null;

  const totalVolume = eligible.reduce((sum, q) => sum + q.quoteVolume, 0);
  const weightedSum = eligible.reduce((sum, q) => sum + q.close * q.quoteVolume, 0);

  return {
    price: weightedSum / totalVolume,
    venuesUsed: eligible.map((q) => q.exchange),
  };
}

import type { UnixMillis } from "./types/brands.js";

export interface RateSeriesPoint {
  timestampMs: UnixMillis;
  value: number;
}

export interface CrossRateDivergence {
  timestampMs: UnixMillis;
  /** composite TAO/USD ÷ composite BTC/USD */
  impliedTaoBtc: number;
  /** composite TAO/BTC, as actually observed */
  observedTaoBtc: number;
  /** |implied - observed| / observed */
  divergence: number;
}

export interface CheckCrossRateOptions {
  /** Fraction (0.05 = 5%) above which a bucket is flagged. Default 0.05. */
  thresholdFraction?: number;
}

/**
 * tao-analytics-plan.md §4.1: "composite TAO/USD ÷ BTC/USD should track
 * composite TAO/BTC. Persistent divergence means a venue is stale or
 * mislabeled." Joins the three series on exact timestamp match and flags
 * buckets where the implied and observed TAO/BTC rates disagree by more than
 * the threshold. Buckets missing from any series are silently skipped — this
 * is a cross-check on buckets all three series agree exist, not a
 * completeness check (that's §5's gap detection).
 */
export function checkCrossRateDivergence(
  taoUsd: readonly RateSeriesPoint[],
  btcUsd: readonly RateSeriesPoint[],
  taoBtc: readonly RateSeriesPoint[],
  opts: CheckCrossRateOptions = {},
): CrossRateDivergence[] {
  const { thresholdFraction = 0.05 } = opts;

  const btcUsdByTs = new Map(btcUsd.map((p) => [p.timestampMs, p.value]));
  const taoBtcByTs = new Map(taoBtc.map((p) => [p.timestampMs, p.value]));

  const out: CrossRateDivergence[] = [];
  for (const { timestampMs, value: taoUsdValue } of taoUsd) {
    const btcUsdValue = btcUsdByTs.get(timestampMs);
    const observedTaoBtc = taoBtcByTs.get(timestampMs);
    if (btcUsdValue === undefined || observedTaoBtc === undefined || btcUsdValue === 0) continue;

    const impliedTaoBtc = taoUsdValue / btcUsdValue;
    const divergence = Math.abs(impliedTaoBtc - observedTaoBtc) / observedTaoBtc;
    if (divergence > thresholdFraction) {
      out.push({ timestampMs, impliedTaoBtc, observedTaoBtc, divergence });
    }
  }
  return out;
}

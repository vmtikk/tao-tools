import { describe, expect, it } from "vitest";
import { checkCrossRateDivergence, type RateSeriesPoint } from "../src/crossRate.js";
import { asUnixMillis } from "../src/types/brands.js";

const t0 = asUnixMillis(1_000);
const t1 = asUnixMillis(2_000);

describe("checkCrossRateDivergence", () => {
  it("flags nothing when the three series agree", () => {
    const taoUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 500 }];
    const btcUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 50_000 }];
    const taoBtc: RateSeriesPoint[] = [{ timestampMs: t0, value: 0.01 }]; // 500/50000 = 0.01
    expect(checkCrossRateDivergence(taoUsd, btcUsd, taoBtc)).toEqual([]);
  });

  it("flags a planted 5% drift", () => {
    const taoUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 500 }];
    const btcUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 50_000 }];
    // implied = 0.01; observed drifted 6% low
    const taoBtc: RateSeriesPoint[] = [{ timestampMs: t0, value: 0.0094 }];

    const result = checkCrossRateDivergence(taoUsd, btcUsd, taoBtc);
    expect(result).toHaveLength(1);
    expect(result[0]!.timestampMs).toBe(t0);
    expect(result[0]!.divergence).toBeGreaterThan(0.05);
  });

  it("does not flag drift under the threshold", () => {
    const taoUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 500 }];
    const btcUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 50_000 }];
    const taoBtc: RateSeriesPoint[] = [{ timestampMs: t0, value: 0.0102 }]; // 2% drift
    expect(checkCrossRateDivergence(taoUsd, btcUsd, taoBtc)).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const taoUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 500 }];
    const btcUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 50_000 }];
    const taoBtc: RateSeriesPoint[] = [{ timestampMs: t0, value: 0.0102 }]; // 2% drift
    const result = checkCrossRateDivergence(taoUsd, btcUsd, taoBtc, { thresholdFraction: 0.01 });
    expect(result).toHaveLength(1);
  });

  it("skips buckets missing from either reference series instead of flagging them", () => {
    const taoUsd: RateSeriesPoint[] = [
      { timestampMs: t0, value: 500 },
      { timestampMs: t1, value: 500 },
    ];
    const btcUsd: RateSeriesPoint[] = [{ timestampMs: t0, value: 50_000 }]; // t1 missing
    const taoBtc: RateSeriesPoint[] = [
      { timestampMs: t0, value: 0.01 },
      { timestampMs: t1, value: 999 }, // would flag hugely if not skipped
    ];
    expect(checkCrossRateDivergence(taoUsd, btcUsd, taoBtc)).toEqual([]);
  });
});

import { asUnixMillis, type UnixMillis } from "./types/brands.js";

/** A missing run of buckets between two observed timestamps. */
export interface GapRange {
  /** First missing bucket's expected timestamp. */
  startMs: UnixMillis;
  /** Last missing bucket's expected timestamp. */
  endMs: UnixMillis;
  missingBuckets: number;
}

/**
 * Given an unordered set of observed bucket timestamps and the expected
 * cadence between them, reports every hole (tao-analytics-plan.md §5, Tier 1:
 * "Gap detection — given a block-height/timestamp sequence with a hole, is
 * the hole reported"; §10: "Silent poller death leaves gaps found months
 * later"). Fewer than two timestamps can't contain a gap.
 */
export function detectGaps(timestampsMs: readonly UnixMillis[], intervalMs: number): GapRange[] {
  if (timestampsMs.length < 2) return [];

  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const gaps: GapRange[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const delta = curr - prev;
    if (delta > intervalMs) {
      gaps.push({
        startMs: asUnixMillis(prev + intervalMs),
        endMs: asUnixMillis(curr - intervalMs),
        missingBuckets: Math.round(delta / intervalMs) - 1,
      });
    }
  }

  return gaps;
}

import type { UnixMillis } from "./brands.js";

/**
 * One weekly point from Google Trends' "interest over time" for a keyword.
 * `value` is 0-100, normalized to the peak week *within the queried date
 * range* — unlike price or view-count data this is not an absolute measure,
 * so a value from one fetch is only comparable to other values from that
 * same fetch (see `trendsClient.ts`'s docstring for why re-fetches can
 * shift older weeks' values slightly).
 */
export interface GoogleTrendsPoint {
  keyword: string;
  /** Monday 00:00 UTC of the week this point covers. */
  weekStartMs: UnixMillis;
  value: number;
  /** True for the current, still-accumulating week. */
  isPartial: boolean;
  /** When this fetch ran — distinguishes points from different re-fetches
   * of the same historical week (their `value` may legitimately differ). */
  fetchedAtMs: UnixMillis;
}

import { withRetry } from "@tao-tools/core";
import { loadEnvFile } from "../env.js";
import { TRENDS_KEYWORDS } from "../social/trendsKeywords.js";
import { fetchGoogleTrends } from "../social/trendsClient.js";
import { writeGoogleTrendsBronze } from "../social/trendsBronzeWriter.js";

/** Matches the earliest date any price venue has TAO data at all
 * (binance TAOUSDT, per README) — keeps the two series comparable over the
 * same window. */
const START_DATE = new Date("2024-04-11T00:00:00Z");

/**
 * Unlike the YouTube snapshot script, this isn't a growing daily append —
 * Google Trends returns the *entire* requested date range in one call
 * (weekly resolution here, since the range is under ~5 years — see
 * `trendsClient.ts`), so "backfill" and "refresh" are the same operation:
 * re-running this later just re-derives the whole series against a later
 * `endDate`, extending it and slightly re-normalizing older weeks. No
 * silver diffing needed the way YouTube's cumulative counters require.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const fetchDate = new Date().toISOString().slice(0, 10);

  for (const keyword of TRENDS_KEYWORDS) {
    const points = await withRetry(() => fetchGoogleTrends(keyword, START_DATE, new Date()), {
      // Google's 429s on the unofficial API lift on the order of minutes,
      // not seconds — retry fast and you hammer a warm ban (observed 2026-09-12:
      // 3s/6s/12s backoff burned all 4 attempts in 24s while still 429).
      maxAttempts: 6,
      baseDelayMs: 60_000,
      factor: 2,
      maxDelayMs: 5 * 60_000,
      onRetry: (attempt, delayMs, err) =>
        console.error(`  retry ${attempt} for "${keyword}" after ${delayMs}ms: ${(err as Error).message}`),
    });
    const result = await writeGoogleTrendsBronze(points, keyword, fetchDate);

    const values = points.map((p) => p.value);
    console.log(
      `${keyword}: wrote ${result.rowCount} weekly points to ${result.destination} ` +
        `(range ${Math.min(...values)}-${Math.max(...values)}, latest ${points.at(-1)?.value}${points.at(-1)?.isPartial ? " partial" : ""})`,
    );
  }
}

main();

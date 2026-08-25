import { asUnixMillis, detectGaps, withRetry } from "@tao-tools/core";
import { fetchCcxtOhlcv } from "../exchanges/ccxtOhlcv.js";
import { groupOhlcvByMonth, paginateOhlcv } from "../exchanges/backfill.js";
import { ALL_VENUES, type PriceVenue } from "../exchanges/venues.js";
import { writeOhlcBronze } from "../bronze/writer.js";
import { appendIngestionLog, gapsToLogEntries } from "../log/ingestionLog.js";

/**
 * TAO's earliest exchange listings are from 2023. A `since` before a given
 * venue's actual listing date is not an error — ccxt/the venue simply
 * returns its own earliest available candles — so one shared anchor that
 * predates every venue is enough; it does not need to match each one
 * exactly (tao-analytics-plan.md §6, Phase 1.2: "full backfill to listing
 * date").
 */
const DEFAULT_SINCE_MS = Date.UTC(2023, 0, 1);

async function backfillVenue(venue: PriceVenue, sinceMs: number): Promise<void> {
  const runAtMs = asUnixMillis(Date.now());

  const rows = await paginateOhlcv({
    exchange: venue.exchange,
    pair: venue.pair,
    sinceMs,
    fetchPage: (pageSinceMs, limit) =>
      withRetry(() =>
        fetchCcxtOhlcv({
          exchangeId: venue.ccxtExchangeId,
          symbol: venue.ccxtSymbol,
          sinceMs: pageSinceMs,
          limit,
        }),
      ),
  });

  console.log(`${venue.exchange} ${venue.pair}: fetched ${rows.length} candles.`);

  for (const [month, monthRows] of groupOhlcvByMonth(rows)) {
    const result = await writeOhlcBronze({
      rows: monthRows,
      exchange: venue.exchange,
      pair: venue.pair,
      month,
    });
    console.log(`  wrote ${result.rowCount} rows -> ${result.destination}`);
  }

  const gaps = detectGaps(
    rows.map((r) => r.timestampMs),
    60_000,
  );
  const logResult = await appendIngestionLog(gapsToLogEntries(venue.exchange, venue.pair, runAtMs, rows.length, gaps));
  if (gaps.length > 0) {
    console.warn(`  ${gaps.length} gap(s) logged to ${logResult.destination}`);
  }
}

/**
 * Phase 1 backfill (tao-analytics-plan.md §6, slice 1.2): every venue in the
 * registry, full history, with gap detection recorded to
 * ingestion_log.parquet. Continues past a single venue's failure so one dead
 * API doesn't block the rest of the run — each failure is reported and the
 * process exits non-zero afterward.
 */
async function main(): Promise<void> {
  const sinceMs = process.env.BACKFILL_SINCE_MS ? Number(process.env.BACKFILL_SINCE_MS) : DEFAULT_SINCE_MS;

  for (const venue of ALL_VENUES) {
    try {
      await backfillVenue(venue, sinceMs);
    } catch (err) {
      console.error(`${venue.exchange} ${venue.pair} failed:`, err);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

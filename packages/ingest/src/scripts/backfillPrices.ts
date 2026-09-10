import { asUnixMillis, detectGaps, withRetry } from "@tao-tools/core";
import { fetchCcxtOhlcv } from "../exchanges/ccxtOhlcv.js";
import { runResumableVenueBackfill } from "../exchanges/backfill.js";
import { ALL_VENUES, type PriceVenue } from "../exchanges/venues.js";
import { writeOhlcBronze } from "../bronze/writer.js";
import { appendIngestionLog, gapsToLogEntries } from "../log/ingestionLog.js";
import {
  readPriceBackfillCheckpoint,
  venueKey,
  writePriceBackfillVenueCheckpoint,
} from "../prices/priceBackfillCheckpoint.js";

/**
 * TAO's earliest exchange listings are from 2023. A `since` before a given
 * venue's actual listing date is not an error — ccxt/the venue simply
 * returns its own earliest available candles — so one shared anchor that
 * predates every venue is enough; it does not need to match each one
 * exactly (tao-analytics-plan.md §6, Phase 1.2: "full backfill to listing
 * date").
 */
const DEFAULT_SINCE_MS = Date.UTC(2023, 0, 1);
const ONE_MIN_MS = 60_000;

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Resumable: reads `data/meta/price_backfill_checkpoint.json` for this
 * venue and, if present, starts one minute past the last durably-flushed
 * candle instead of `defaultSinceMs` — so stopping the process (closed
 * terminal, computer shutdown, Ctrl+C) and rerunning the exact same command
 * later continues each venue from where it left off rather than re-fetching
 * years of already-backfilled history. An explicit `BACKFILL_SINCE_MS`
 * override only applies to venues that have no checkpoint yet — it can't
 * accidentally discard resume progress; delete the checkpoint file to force
 * a full re-backfill.
 */
async function backfillVenue(venue: PriceVenue, defaultSinceMs: number): Promise<void> {
  const runAtMs = asUnixMillis(Date.now());
  const key = venueKey(venue.exchange, venue.pair);
  const checkpoint = readPriceBackfillCheckpoint()[key];
  const sinceMs = checkpoint ? checkpoint.lastWrittenMs + ONE_MIN_MS : defaultSinceMs;

  console.log(
    checkpoint
      ? `${venue.exchange} ${venue.pair}: resuming from checkpoint at ${formatTimestamp(sinceMs)}.`
      : `${venue.exchange} ${venue.pair}: starting fresh from ${formatTimestamp(sinceMs)}.`,
  );

  const { rows } = await runResumableVenueBackfill({
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
    flushMonth: async (month, monthRows) => {
      const result = await writeOhlcBronze({ rows: monthRows, exchange: venue.exchange, pair: venue.pair, month });
      console.log(`  ${venue.exchange} ${venue.pair}: wrote ${result.rowCount} rows -> ${result.destination}`);
    },
    onCheckpoint: (lastWrittenMs) => {
      writePriceBackfillVenueCheckpoint(key, lastWrittenMs);
      console.log(`  ${venue.exchange} ${venue.pair}: checkpoint saved at ${formatTimestamp(lastWrittenMs)}.`);
    },
    onProgress: ({ pageIndex, pageRowCount, totalRowCount, latestTimestampMs }) => {
      console.log(
        `  ${venue.exchange} ${venue.pair}: page ${pageIndex + 1}, +${pageRowCount} candles ` +
          `(reached ${formatTimestamp(latestTimestampMs)}), ${totalRowCount} fetched this run.`,
      );
    },
  });

  console.log(`${venue.exchange} ${venue.pair}: done, fetched ${rows.length} candles this run.`);

  const gaps = detectGaps(rows.map((r) => r.timestampMs), ONE_MIN_MS);
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

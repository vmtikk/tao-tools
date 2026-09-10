import { loadEnvFile } from "../env.js";
import { fetchCcxtOhlcv, normalizeCcxtOhlcv } from "../exchanges/ccxtOhlcv.js";
import { writeOhlcBronze } from "../bronze/writer.js";
import { USD_VENUES } from "../exchanges/venues.js";

/**
 * Phase 0 tracer bullet (tao-analytics-plan.md §6): Kraken TAO/USD, the most
 * recent 24 hours, 1-minute candles, all the way to bronze. Migrated to
 * ccxt in Phase 1 along with every other venue (§2 stack) — the venue is
 * still just Kraken and the window is still just 24h; only the fetch client
 * changed.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const venue = USD_VENUES.find((v) => v.exchange === "kraken");
  if (!venue) throw new Error('USD_VENUES has no "kraken" entry');

  const sinceMs = Date.now() - 24 * 60 * 60 * 1000;

  const raw = await fetchCcxtOhlcv({ exchangeId: venue.ccxtExchangeId, symbol: venue.ccxtSymbol, sinceMs });
  const rows = normalizeCcxtOhlcv(raw, { exchange: venue.exchange, pair: venue.pair });

  console.log(`Fetched ${rows.length} candles from Kraken TAO/USD.`);

  const month = new Date().toISOString().slice(0, 7); // yyyy-mm
  const result = await writeOhlcBronze({
    rows,
    exchange: venue.exchange,
    pair: venue.pair,
    month,
  });

  console.log(`Wrote ${result.rowCount} rows to ${result.destination}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

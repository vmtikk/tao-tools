import { fetchKrakenOhlc, normalizeKrakenOhlc } from "../exchanges/kraken.js";
import { writeOhlcBronze } from "../bronze/writer.js";

/**
 * Phase 0 tracer bullet (tao-analytics-plan.md §6): Kraken TAO/USD, the most
 * recent 24 hours, 1-minute candles, all the way to bronze.
 */
async function main(): Promise<void> {
  const sinceSeconds = Math.floor(Date.now() / 1000) - 24 * 60 * 60;

  const response = await fetchKrakenOhlc({ pair: "TAOUSD", intervalMinutes: 1, sinceSeconds });
  const rows = normalizeKrakenOhlc(response, { pair: "TAOUSD", intervalMinutes: 1 });

  console.log(`Fetched ${rows.length} candles from Kraken TAO/USD.`);

  const month = new Date().toISOString().slice(0, 7); // yyyy-mm
  const result = await writeOhlcBronze({
    rows,
    exchange: "kraken",
    pair: "TAOUSD",
    month,
  });

  console.log(`Wrote ${result.rowCount} rows to ${result.destination}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

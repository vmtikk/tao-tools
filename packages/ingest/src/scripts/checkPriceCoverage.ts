import { existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { configureR2Secret } from "../bronze/r2Secret.js";
import { metaDir, resolveBronzeUri } from "../paths.js";
import { ALL_VENUES } from "../exchanges/venues.js";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Reports what's actually in bronze for every configured price venue — row
 * count, date range, and distinct months present — so "did the backfill
 * actually get full history, or just a thin slice?" has a real answer
 * instead of having to re-derive it from the checkpoint file and a
 * hand-rolled DuckDB query each time (as happened for real, 2026-09-10).
 * Read-only, no RPC, works against local bronze or R2 depending on
 * `BRONZE_URI` exactly like every other bronze reader. Also surfaces any
 * gaps `backfillPrices.ts` already detected and logged to
 * `ingestion_log.parquet` — that log has existed since Phase 1.2 but was
 * never actually read back anywhere until now.
 */
async function main(): Promise<void> {
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");

  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    if (isRemote) await configureR2Secret(connection);

    console.log(`Bronze: ${bronzeUri}\n`);

    for (const venue of ALL_VENUES) {
      const path = `${bronzeUri}/prices/${venue.exchange}/${venue.pair}/*.parquet`;
      try {
        const result = await connection.run(`
          SELECT
            MIN(timestamp_ms) AS min_ts,
            MAX(timestamp_ms) AS max_ts,
            COUNT(*) AS n,
            COUNT(DISTINCT strftime(to_timestamp(timestamp_ms / 1000), '%Y-%m')) AS months
          FROM read_parquet('${escapeSqlLiteral(path)}');
        `);
        const rows = await result.getRows();
        const [minTs, maxTs, n, months] = rows[0]!;
        if (minTs === null) {
          console.log(`${venue.exchange.padEnd(10)} ${venue.pair.padEnd(8)} NO DATA`);
          continue;
        }
        const minMs = Number(minTs);
        const maxMs = Number(maxTs);
        const spanDays = (maxMs - minMs) / 86_400_000;
        console.log(
          `${venue.exchange.padEnd(10)} ${venue.pair.padEnd(8)} ` +
            `${formatDate(minMs)} -> ${formatDate(maxMs)}  ` +
            `(${spanDays.toFixed(0)}d, ${months} distinct months, ${n} rows)`,
        );
      } catch {
        console.log(`${venue.exchange.padEnd(10)} ${venue.pair.padEnd(8)} NO DATA (no bronze files found)`);
      }
    }

    const ingestionLogPath = `${metaDir()}/ingestion_log.parquet`;
    if (existsSync(ingestionLogPath)) {
      // Summarized, not dumped: a low-liquidity venue can log thousands of
      // tiny 1-2 minute gaps (a market with no trade in a given minute has
      // no candle for that minute at all) — real, but not worth thousands
      // of lines. Per venue: total gap count + missing buckets, plus the
      // handful of largest gaps, which are the ones actually worth looking at.
      const summaryResult = await connection.run(`
        SELECT exchange, pair, COUNT(*) AS gap_count, SUM(missing_buckets) AS total_missing
        FROM read_parquet('${escapeSqlLiteral(ingestionLogPath)}')
        WHERE gap_start_ms IS NOT NULL
        GROUP BY exchange, pair
        ORDER BY exchange, pair;
      `);
      const summaryRows = await summaryResult.getRows();
      if (summaryRows.length > 0) {
        console.log("\nLogged gaps (summary — mostly expected on low-liquidity venues/periods):");
        for (const row of summaryRows) {
          const [exchange, pair, gapCount, totalMissing] = row;
          console.log(`  ${exchange} ${pair}: ${gapCount} gaps, ${totalMissing} missing 1-minute buckets total`);
        }

        const largestResult = await connection.run(`
          SELECT exchange, pair, gap_start_ms, gap_end_ms, missing_buckets
          FROM read_parquet('${escapeSqlLiteral(ingestionLogPath)}')
          WHERE gap_start_ms IS NOT NULL
          ORDER BY missing_buckets DESC
          LIMIT 10;
        `);
        const largestRows = await largestResult.getRows();
        console.log("\nLargest individual gaps:");
        for (const row of largestRows) {
          const [exchange, pair, gapStartMs, gapEndMs, missingBuckets] = row;
          console.log(
            `  ${exchange} ${pair}: ${formatDate(Number(gapStartMs))} -> ${formatDate(Number(gapEndMs))} ` +
              `(${missingBuckets} missing 1-minute buckets)`,
          );
        }
      } else {
        console.log("\nNo gaps logged in ingestion_log.parquet.");
      }
    } else {
      console.log(`\nNo ingestion log found at ${ingestionLogPath} yet.`);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { mkdirSync } from "node:fs";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";

export interface MaterializeSilverGoogleTrendsResult {
  destination: string;
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * bronze/social/google_trends/{keyword-slug}/{fetch-date}.parquet ->
 * silver/google_trends.parquet. Each bronze file holds a keyword's *entire*
 * re-normalized series as of one fetch (see `trendsBronzeWriter.ts`) — this
 * keeps only the most recent fetch per keyword, picked by each row's own
 * `fetched_at_ms` (not the file's date in its path, since that's the value
 * that actually varies run to run), so re-running `trends:backfill` and
 * re-materializing always reflects the latest 0-100 scale rather than mixing
 * weeks normalized against different peaks from different fetches.
 *
 * Returns null (writes nothing) if no Trends bronze exists yet —
 * `trends:backfill` is optional, and an environment that hasn't run it is a
 * valid state, not an error (same treatment `silver_transfers`/
 * `silver_balance_events` get in `materializeGold` for an environment that
 * hasn't run chain ingestion).
 */
export async function materializeSilverGoogleTrends(): Promise<MaterializeSilverGoogleTrendsResult | null> {
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");
  const globPattern = `${bronzeUri}/social/google_trends/*/*.parquet`;
  const destination = `${silverDir()}/google_trends.parquet`;

  mkdirSync(silverDir(), { recursive: true });

  return withDuckDb(
    async (connection) => {
      try {
        await connection.run(
          `CREATE OR REPLACE TABLE bronze_trends AS
           SELECT keyword, week_start_ms, value, is_partial, fetched_at_ms
           FROM read_parquet('${escapeSqlLiteral(globPattern)}');`,
        );
      } catch {
        return null; // no trends bronze written yet
      }

      await connection.run(
        `COPY (
           SELECT keyword, week_start_ms, value, is_partial, fetched_at_ms
           FROM (
             SELECT *, MAX(fetched_at_ms) OVER (PARTITION BY keyword) AS latest_fetched_at_ms
             FROM bronze_trends
           )
           WHERE fetched_at_ms = latest_fetched_at_ms
           ORDER BY keyword, week_start_ms
         ) TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
      );
      const result = await connection.run(`SELECT COUNT(*) AS n FROM read_parquet('${escapeSqlLiteral(destination)}');`);
      const rows = await result.getRows();
      return { destination, rowCount: Number(rows[0]?.[0] ?? 0) };
    },
    { needsR2: isRemote },
  );
}

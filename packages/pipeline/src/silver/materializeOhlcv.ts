import { mkdirSync } from "node:fs";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";

export interface MaterializeSilverOhlcvResult {
  destination: string;
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * bronze prices/{exchange}/{pair}/{yyyy-mm}.parquet -> silver/ohlcv_1m.parquet
 * (tao-analytics-plan.md §6, Phase 0). Unions every venue/pair/month bronze
 * file present; Phase 1 widening venues changes nothing here.
 */
export async function materializeSilverOhlcv(): Promise<MaterializeSilverOhlcvResult> {
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");
  const globPattern = `${bronzeUri}/prices/*/*/*.parquet`;
  const destination = `${silverDir()}/ohlcv_1m.parquet`;

  mkdirSync(silverDir(), { recursive: true });

  const rowCount = await withDuckDb(
    async (connection) => {
      await connection.run(
        `CREATE OR REPLACE TABLE bronze_ohlcv AS
         SELECT exchange, pair, timestamp_ms, open, high, low, close, base_volume, quote_volume, is_partial
         FROM read_parquet('${escapeSqlLiteral(globPattern)}');`,
      );
      await connection.run(
        `COPY (
           SELECT DISTINCT exchange, pair, timestamp_ms, open, high, low, close, base_volume, quote_volume, is_partial
           FROM bronze_ohlcv
           ORDER BY exchange, pair, timestamp_ms
         ) TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
      );
      const result = await connection.run("SELECT COUNT(*) AS n FROM bronze_ohlcv;");
      const rows = await result.getRows();
      return Number(rows[0]?.[0] ?? 0);
    },
    { needsR2: isRemote },
  );

  return { destination, rowCount };
}

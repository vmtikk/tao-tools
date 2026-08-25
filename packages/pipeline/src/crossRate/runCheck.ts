import { checkCrossRateDivergence, asUnixMillis, type CrossRateDivergence, type RateSeriesPoint } from "@tao-tools/core";
import { withDuckDb } from "../duckdb/session.js";
import { goldDir } from "../paths.js";
import { goldFileForMetric } from "../registry/goldFiles.js";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function loadSeries(metric: string): Promise<RateSeriesPoint[]> {
  const file = `${goldDir()}/${goldFileForMetric(metric)}.parquet`;
  return withDuckDb(async (connection) => {
    const result = await connection.run(
      `SELECT timestamp_ms, value FROM read_parquet('${escapeSqlLiteral(file)}') ORDER BY timestamp_ms;`,
    );
    const rows = await result.getRows();
    return rows.map((row) => ({ timestampMs: asUnixMillis(Number(row[0])), value: Number(row[1]) }));
  });
}

export interface CrossRateCheckResult {
  divergences: CrossRateDivergence[];
}

/**
 * tao-analytics-plan.md §6, Phase 1.3: "the cross-rate sanity check as a
 * scheduled assertion". Loads the three already-materialized gold series and
 * runs core's pure divergence check against them — this module owns the I/O,
 * `checkCrossRateDivergence` owns the logic, matching §3's split between
 * plumbing and the parts of the pipeline that can produce a wrong number.
 */
export async function runCrossRateCheck(): Promise<CrossRateCheckResult> {
  const [taoUsd, btcUsd, taoBtc] = await Promise.all([
    loadSeries("price_composite_usd"),
    loadSeries("reference_btc_usd"),
    loadSeries("price_composite_btc"),
  ]);
  return { divergences: checkCrossRateDivergence(taoUsd, btcUsd, taoBtc) };
}

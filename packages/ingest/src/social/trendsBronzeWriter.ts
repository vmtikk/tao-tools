import type { GoogleTrendsPoint } from "@tao-tools/core";
import { writeRowsAsParquet, type WriteRowsAsParquetResult } from "../bronze/parquetWriter.js";
import { resolveBronzeUri as resolveDefaultBronzeUri } from "../paths.js";

function slugify(keyword: string): string {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function toSnakeCaseRow(row: GoogleTrendsPoint): Record<string, unknown> {
  return {
    keyword: row.keyword,
    week_start_ms: row.weekStartMs,
    value: row.value,
    is_partial: row.isPartial,
    fetched_at_ms: row.fetchedAtMs,
  };
}

/**
 * One file per fetch run, keyed by fetch date — each file holds the *entire*
 * re-normalized series for that keyword, not just new points. Unlike price
 * OHLCV bronze there's nothing to merge: Trends recomputes the whole 0-100
 * scale on every fetch (`trendsClient.ts`), so an old file's values for a
 * given week aren't on the same scale as a new file's. Silver is expected to
 * read the most recent file per keyword as the current series.
 */
export async function writeGoogleTrendsBronze(
  rows: readonly GoogleTrendsPoint[],
  keyword: string,
  fetchDate: string,
  bronzeUri?: string,
): Promise<WriteRowsAsParquetResult> {
  const uri = (bronzeUri ?? resolveDefaultBronzeUri()).replace(/\\/g, "/").replace(/\/+$/, "");
  return writeRowsAsParquet({
    rows: rows.map(toSnakeCaseRow),
    destination: `${uri}/social/google_trends/${slugify(keyword)}/${fetchDate}.parquet`,
  });
}

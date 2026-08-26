import type { Ohlcv } from "@tao-tools/core";
import { resolveBronzeUri as resolveDefaultBronzeUri } from "../paths.js";
import { writeRowsAsParquet, type WriteRowsAsParquetResult } from "./parquetWriter.js";

export interface WriteBronzeOptions {
  rows: readonly Ohlcv[];
  exchange: string;
  pair: string;
  /** yyyy-mm bucket, e.g. "2026-08" — matches the layout in §2. */
  month: string;
  /** Defaults to env BRONZE_URI, then "./data/bronze" (local stand-in for R2). */
  bronzeUri?: string;
}

export type WriteBronzeResult = WriteRowsAsParquetResult;

/** Bronze columns are snake_case, matching every other layer (§2 layout). */
function toSnakeCaseRow(row: Ohlcv): Record<string, unknown> {
  return {
    exchange: row.exchange,
    pair: row.pair,
    timestamp_ms: row.timestampMs,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    base_volume: row.baseVolume,
    quote_volume: row.quoteVolume,
    is_partial: row.isPartial,
  };
}

function resolveBronzeUri(explicit: string | undefined): string {
  const uri = explicit ?? resolveDefaultBronzeUri();
  return uri.replace(/\\/g, "/").replace(/\/+$/, "");
}

export async function writeOhlcBronze(opts: WriteBronzeOptions): Promise<WriteBronzeResult> {
  const bronzeUri = resolveBronzeUri(opts.bronzeUri);
  const destination = `${bronzeUri}/prices/${opts.exchange}/${opts.pair}/${opts.month}.parquet`;
  return writeRowsAsParquet({ rows: opts.rows.map(toSnakeCaseRow), destination });
}

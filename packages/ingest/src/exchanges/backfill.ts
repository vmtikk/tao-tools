import type { OHLCV } from "ccxt";
import { asUnixMillis, type Ohlcv, type UnixMillis } from "@tao-tools/core";
import { normalizeCcxtOhlcv } from "./ccxtOhlcv.js";

export interface PaginateOhlcvOptions {
  exchange: string;
  pair: string;
  intervalMinutes?: number;
  /** Unix milliseconds to start from. Fine to predate a venue's actual
   * listing — it will simply return its own earliest available candles
   * (tao-analytics-plan.md §6, Phase 1.2: "full backfill to listing date"). */
  sinceMs: number;
  limit?: number;
  nowMs?: UnixMillis;
  /** Safety cap so a misbehaving venue can't loop forever. */
  maxPages?: number;
  fetchPage: (sinceMs: number, limit: number) => Promise<OHLCV[]>;
}

/**
 * Pages through a venue's OHLCV history from `sinceMs` up to the live edge.
 * All I/O is delegated to the injected `fetchPage` (typically
 * `fetchCcxtOhlcv` wrapped in `withRetry`), so this orchestration — the part
 * with actual logic worth getting wrong — is unit-testable without a
 * network call.
 */
export async function paginateOhlcv(opts: PaginateOhlcvOptions): Promise<Ohlcv[]> {
  const { exchange, pair, intervalMinutes = 1, limit = 720, maxPages = 100_000, fetchPage } = opts;
  const nowMs = opts.nowMs ?? asUnixMillis(Date.now());
  const intervalMs = intervalMinutes * 60_000;

  let sinceMs = opts.sinceMs;
  const rows: Ohlcv[] = [];

  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchPage(sinceMs, limit);
    if (raw.length === 0) break;

    const normalized = normalizeCcxtOhlcv(raw, { exchange, pair, intervalMinutes, nowMs });
    rows.push(...normalized);

    const lastTs = normalized.at(-1)!.timestampMs;
    const nextSinceMs = lastTs + intervalMs;
    if (nextSinceMs <= sinceMs) break; // no forward progress — avoid spinning forever
    sinceMs = nextSinceMs;

    if (lastTs >= nowMs - intervalMs) break; // caught up to the live edge
    if (raw.length < limit) break; // venue returned less than asked for: history exhausted
  }

  return rows;
}

/** Groups normalized rows by yyyy-mm bucket, matching bronze's monthly
 * Parquet layout (§2). */
export function groupOhlcvByMonth(rows: readonly Ohlcv[]): Map<string, Ohlcv[]> {
  const byMonth = new Map<string, Ohlcv[]>();
  for (const row of rows) {
    const month = new Date(row.timestampMs).toISOString().slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket) {
      bucket.push(row);
    } else {
      byMonth.set(month, [row]);
    }
  }
  return byMonth;
}

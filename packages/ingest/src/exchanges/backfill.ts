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
  /** Called after each page is fetched and normalized, before the next
   * page is requested — lets a caller flush rows incrementally (bronze
   * writes, checkpoints, progress logs) instead of waiting for the whole
   * history to be paginated into memory first. */
  onPage?: (pageRows: readonly Ohlcv[], pageIndex: number) => void | Promise<void>;
}

/**
 * Pages through a venue's OHLCV history from `sinceMs` up to the live edge.
 * All I/O is delegated to the injected `fetchPage` (typically
 * `fetchCcxtOhlcv` wrapped in `withRetry`), so this orchestration — the part
 * with actual logic worth getting wrong — is unit-testable without a
 * network call.
 */
export async function paginateOhlcv(opts: PaginateOhlcvOptions): Promise<Ohlcv[]> {
  const { exchange, pair, intervalMinutes = 1, limit = 720, maxPages = 100_000, fetchPage, onPage } = opts;
  const nowMs = opts.nowMs ?? asUnixMillis(Date.now());
  const intervalMs = intervalMinutes * 60_000;

  let sinceMs = opts.sinceMs;
  const rows: Ohlcv[] = [];

  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchPage(sinceMs, limit);
    if (raw.length === 0) break;

    const normalized = normalizeCcxtOhlcv(raw, { exchange, pair, intervalMinutes, nowMs });
    rows.push(...normalized);
    await onPage?.(normalized, page);

    const lastTs = normalized.at(-1)!.timestampMs;
    const nextSinceMs = lastTs + intervalMs;
    if (nextSinceMs <= sinceMs) break; // no forward progress — avoid spinning forever
    sinceMs = nextSinceMs;

    if (lastTs >= nowMs - intervalMs) break; // caught up to the live edge
    // Deliberately no "raw.length < limit => history exhausted" check here.
    // Found for real (2026-09-10): Coinbase, OKX, and MEXC each cap their own
    // OHLCV response below whatever `limit` is requested (270, 300, 224 vs.
    // the default 720) — that used to be misread as "history exhausted",
    // permanently stalling those venues after their very first page no
    // matter how much real history remained. An empty page (above) is the
    // only reliable "nothing here" signal; a short page just means more
    // pages are needed to cover the same span.
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

export interface FindEarliestAvailableSinceMsOptions {
  /** Where the caller would like to start — typically predates every
   * venue's real listing (e.g. 2023-01-01, tao-analytics-plan.md §6, Phase
   * 1.2's shared anchor). */
  sinceMs: number;
  nowMs: number;
  /** Resolves true if at least one candle exists at/after the given
   * timestamp. Cheap — a `limit: 1` fetch, not a full page. */
  probe: (sinceMs: number) => Promise<boolean>;
  /** Stop narrowing once the search window is this small — coarser is
   * cheaper (fewer probe calls) but risks missing a small number of real
   * candles right at the true boundary. Defaults to 1 day. */
  toleranceMs?: number;
  maxProbes?: number;
}

/**
 * Binary-searches for the earliest timestamp a venue actually has data at,
 * for venues whose OHLCV endpoint returns an *empty* page for a `since`
 * before the pair's real listing date rather than clamping to its own
 * earliest candle the way Binance's does. Found for real (2026-09-09):
 * Coinbase, OKX, and MEXC all returned 0 candles for `since=2023-01-01`
 * (TAO/USDT and TAO/USD's real listing dates are later) but real, current
 * candles for a recent `since` — `paginateOhlcv`'s "stop on an empty page"
 * rule (correct for "history has ended") was misreading "history hasn't
 * started yet" the same way, permanently stalling these venues at zero rows
 * on every run.
 *
 * Relies on availability being monotonic (once a venue has a candle at time
 * T, it has one at every T' > T) — true for a continuously-listed, actively
 * traded pair, which is what confirming a recent, non-empty point verifies
 * before searching. Returns `null` if there's no data at all right now (the
 * venue has nothing, a different problem this search can't fix) or
 * `sinceMs` unchanged if data is already available there (the common case —
 * most venues don't need this search at all).
 */
export async function findEarliestAvailableSinceMs(
  opts: FindEarliestAvailableSinceMsOptions,
): Promise<number | null> {
  const { sinceMs, nowMs, probe, toleranceMs = 24 * 60 * 60 * 1000, maxProbes = 64 } = opts;

  if (await probe(sinceMs)) return sinceMs;

  // Confirm some safely-recent point actually has data before trusting the
  // monotonic-availability assumption below. Found for real (2026-09-09):
  // probing at the literal current instant returned empty for otherwise-live
  // venues (Coinbase, OKX) — no closed candle exists yet for a timestamp
  // that recent — which would have wrongly concluded "no data at all."
  // Stepping back a few `toleranceMs` steps finds a point with a real,
  // closed candle without giving up too early.
  let hi = nowMs;
  let confirmedHi = false;
  for (let i = 0; i < 5 && hi > sinceMs; i++) {
    if (await probe(hi)) {
      confirmedHi = true;
      break;
    }
    hi -= toleranceMs;
  }
  if (!confirmedHi) return null;

  let lo = sinceMs; // confirmed empty
  for (let i = 0; i < maxProbes && hi - lo > toleranceMs; i++) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await probe(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

export interface RunResumableVenueBackfillOptions {
  exchange: string;
  pair: string;
  /** Resolved by the caller — typically a checkpoint's `lastWrittenMs + intervalMs`
   * on resume, or a fixed default (e.g. listing date) on a first run. */
  sinceMs: number;
  intervalMinutes?: number;
  limit?: number;
  maxPages?: number;
  nowMs?: UnixMillis;
  fetchPage: (sinceMs: number, limit: number) => Promise<OHLCV[]>;
  /** Writes one completed month's rows to bronze. Called only for a month
   * that will never receive more rows in this run (see below), so it's safe
   * to write the whole month in one shot rather than appending. */
  flushMonth: (month: string, rows: readonly Ohlcv[]) => Promise<void>;
  /** Persists resume progress after every `flushMonth` call, so a crash
   * between two flushes loses at most the one month still pending, never
   * anything already durably written. Called with the max timestamp among
   * all rows flushed so far (this run's checkpoint value only advances). */
  onCheckpoint: (lastWrittenMs: number) => void | Promise<void>;
  onProgress?: (info: {
    pageIndex: number;
    pageRowCount: number;
    totalRowCount: number;
    latestTimestampMs: number;
  }) => void;
}

export interface RunResumableVenueBackfillResult {
  /** Every row fetched this run (across all pages) — the caller's own gap
   * detection needs this even though most of it has already been flushed
   * to bronze page-by-page. */
  rows: Ohlcv[];
}

/**
 * Wraps a raw `fetchPage` so an empty response doesn't automatically mean
 * "nothing more here." Found for real, twice (2026-09-09/10): Coinbase,
 * OKX, and MEXC all returned 0 candles for a `since` before their real
 * listing date (not an error, not clamped to their earliest candle the way
 * Binance's endpoint does it for us) — and separately, Coinbase returned an
 * empty page for one specific minute *in the middle* of otherwise-continuous
 * history (a real ~1-day gap, data resumed the next day), which stalled a
 * resumed run at exactly that point on every subsequent rerun since an
 * empty page there permanently looked identical to "caught up, nothing
 * new." Both are the same underlying shape: an empty page that isn't
 * actually the live edge.
 *
 * An empty page at/near `nowMs` is left alone — that's the ordinary,
 * frequent "already caught up" case on a daily resumed run, and searching
 * forward there would cost real probe calls for no reason on every single
 * run. Only an empty page still meaningfully behind `nowMs` triggers the
 * forward search (`findEarliestAvailableSinceMs`), which itself first
 * checks whether `nowMs` has any data at all — a dead/delisted pair still
 * correctly stops rather than searching forever.
 */
function withGapSkipping(
  fetchPage: (sinceMs: number, limit: number) => Promise<OHLCV[]>,
  nowMs: number,
  intervalMs: number,
): (sinceMs: number, limit: number) => Promise<OHLCV[]> {
  return async (sinceMs, limit) => {
    const raw = await fetchPage(sinceMs, limit);
    if (raw.length > 0) return raw;
    if (sinceMs >= nowMs - intervalMs) return raw; // caught up — an empty page here is expected

    const nextAvailableMs = await findEarliestAvailableSinceMs({
      sinceMs,
      nowMs,
      probe: async (probeSinceMs) => (await fetchPage(probeSinceMs, 1)).length > 0,
    });
    if (nextAvailableMs === null) return raw; // genuinely nothing left, even at nowMs

    return fetchPage(nextAvailableMs, limit);
  };
}

/**
 * `paginateOhlcv` plus incremental bronze writes and a resumable checkpoint
 * (tao-analytics-plan.md §6, Phase 1.2). Buffers at most the *current*,
 * not-yet-complete month's rows in memory (bounded — one month of 1-minute
 * candles is ~44,640 rows) instead of the whole multi-year history, and
 * flushes a month to bronze as soon as pagination moves past it — a page
 * covers at most `limit` minutes (720 by default = 12h), so once a later
 * page's timestamps land in month N+1, month N can never receive another
 * row and is safe to write once and never touch again. This is what makes
 * "shut the computer down mid-run, resume the next day" cheap rather than
 * "redo the whole venue from the default start date": a crash loses at most
 * the one month still pending, and `onCheckpoint` only ever moves forward.
 */
export async function runResumableVenueBackfill(
  opts: RunResumableVenueBackfillOptions,
): Promise<RunResumableVenueBackfillResult> {
  const { exchange, pair, flushMonth, onCheckpoint, onProgress } = opts;
  const nowMs = opts.nowMs ?? asUnixMillis(Date.now());
  const intervalMs = (opts.intervalMinutes ?? 1) * 60_000;
  const fetchPage = withGapSkipping(opts.fetchPage, nowMs, intervalMs);

  let pending: Ohlcv[] = [];
  let lastWrittenMs: number | null = null;
  let totalRowCount = 0;

  async function flushAllExceptLatestMonth(): Promise<void> {
    const byMonth = groupOhlcvByMonth(pending);
    const months = [...byMonth.keys()].sort();
    for (const month of months.slice(0, -1)) {
      const monthRows = byMonth.get(month)!;
      await flushMonth(month, monthRows);
      lastWrittenMs = Math.max(lastWrittenMs ?? -Infinity, monthRows.at(-1)!.timestampMs);
      await onCheckpoint(lastWrittenMs);
    }
    pending = months.length > 0 ? byMonth.get(months.at(-1)!)! : [];
  }

  const rows = await paginateOhlcv({
    exchange,
    pair,
    intervalMinutes: opts.intervalMinutes,
    sinceMs: opts.sinceMs,
    limit: opts.limit,
    maxPages: opts.maxPages,
    nowMs: opts.nowMs,
    fetchPage,
    onPage: async (pageRows, pageIndex) => {
      pending.push(...pageRows);
      totalRowCount += pageRows.length;
      onProgress?.({
        pageIndex,
        pageRowCount: pageRows.length,
        totalRowCount,
        latestTimestampMs: pageRows.at(-1)?.timestampMs ?? opts.sinceMs,
      });
      await flushAllExceptLatestMonth();
    },
  });

  // Whatever's left pending is the final (possibly partial) month — safe to
  // flush now since pagination has fully finished.
  if (pending.length > 0) {
    const byMonth = groupOhlcvByMonth(pending);
    for (const [month, monthRows] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await flushMonth(month, monthRows);
      lastWrittenMs = Math.max(lastWrittenMs ?? -Infinity, monthRows.at(-1)!.timestampMs);
      await onCheckpoint(lastWrittenMs);
    }
  }

  return { rows };
}

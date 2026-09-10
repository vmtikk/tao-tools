import { describe, expect, it } from "vitest";
import type { OHLCV } from "ccxt";
import { asUnixMillis } from "@tao-tools/core";
import {
  findEarliestAvailableSinceMs,
  groupOhlcvByMonth,
  paginateOhlcv,
  runResumableVenueBackfill,
} from "../src/exchanges/backfill.js";

const ONE_MIN = 60_000;

function candle(tsMs: number, close: number): OHLCV {
  return [tsMs, close, close, close, close, 1];
}

describe("paginateOhlcv (unit — orchestration over an injected fetchPage)", () => {
  it("stops once it catches up to the live edge", async () => {
    const nowMs = asUnixMillis(5 * ONE_MIN);
    let calls = 0;
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 3,
      nowMs,
      fetchPage: async (sinceMs) => {
        calls++;
        // Each page returns up to 3 candles starting at sinceMs, capped at "now".
        const candles: OHLCV[] = [];
        for (let t = sinceMs; t < sinceMs + 3 * ONE_MIN && t <= nowMs; t += ONE_MIN) {
          candles.push(candle(t, 100));
        }
        return candles;
      },
    });

    expect(rows.map((r) => r.timestampMs)).toEqual([0, ONE_MIN, 2 * ONE_MIN, 3 * ONE_MIN, 4 * ONE_MIN, 5 * ONE_MIN]);
    expect(calls).toBe(2);
  });

  /**
   * Found for real (2026-09-10): Coinbase, OKX, and MEXC each silently cap
   * their own OHLCV response below the requested `limit` (270, 300, 224 vs.
   * a default of 720) — an earlier version of this loop treated any
   * shorter-than-asked page as "history exhausted" and stopped for good
   * after page one, even with years of real history still ahead. A short
   * page that still makes real forward progress must keep paginating; only
   * an empty page (below) or reaching the live edge should stop it.
   */
  it("keeps paginating when a venue caps its own page size below the requested limit", async () => {
    const nowMs = asUnixMillis(25 * ONE_MIN);
    let calls = 0;
    const rows = await paginateOhlcv({
      exchange: "coinbase",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 10, // asked for 10 candles/page
      nowMs,
      fetchPage: async (sinceMs) => {
        calls++;
        // This venue always caps its own response at 3, regardless of what's asked.
        const candles: OHLCV[] = [];
        for (let t = sinceMs; t < sinceMs + 3 * ONE_MIN && t <= nowMs; t += ONE_MIN) {
          candles.push(candle(t, 100));
        }
        return candles;
      },
    });

    expect(calls).toBeGreaterThan(1); // did not stop after the first short page
    expect(rows.map((r) => r.timestampMs)).toEqual(
      Array.from({ length: 26 }, (_, i) => i * ONE_MIN), // paged all the way to the live edge
    );
  });

  it("stops immediately when a page comes back empty", async () => {
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      nowMs: asUnixMillis(1_000 * ONE_MIN),
      fetchPage: async () => [],
    });
    expect(rows).toEqual([]);
  });

  it("does not loop forever when a venue keeps returning the same stale page", async () => {
    let calls = 0;
    const rows = await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 5,
      nowMs: asUnixMillis(1_000 * ONE_MIN),
      fetchPage: async () => {
        calls++;
        return [candle(0, 100)]; // same single candle forever, no progress
      },
    });
    // The first call looks like real progress (0 -> requested next-since);
    // only the second identical call reveals sinceMs isn't actually
    // advancing, so it takes one extra call (vs. the old length-based
    // shortcut) to detect — still bounded, never infinite.
    expect(rows).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("respects maxPages as a hard safety cap", async () => {
    let calls = 0;
    await paginateOhlcv({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: 0,
      limit: 1,
      maxPages: 3,
      nowMs: asUnixMillis(1_000_000 * ONE_MIN),
      fetchPage: async (sinceMs) => {
        calls++;
        return [candle(sinceMs, 100)]; // always makes forward progress, never exhausts
      },
    });
    expect(calls).toBe(3);
  });
});

describe("groupOhlcvByMonth", () => {
  it("buckets rows by yyyy-mm", () => {
    const rows = [
      { timestampMs: Date.UTC(2026, 0, 15), exchange: "k", pair: "TAOUSD", open: 1, high: 1, low: 1, close: 1, baseVolume: 1, quoteVolume: 1, isPartial: false },
      { timestampMs: Date.UTC(2026, 0, 20), exchange: "k", pair: "TAOUSD", open: 1, high: 1, low: 1, close: 1, baseVolume: 1, quoteVolume: 1, isPartial: false },
      { timestampMs: Date.UTC(2026, 1, 1), exchange: "k", pair: "TAOUSD", open: 1, high: 1, low: 1, close: 1, baseVolume: 1, quoteVolume: 1, isPartial: false },
    ] as const;
    const byMonth = groupOhlcvByMonth(rows as unknown as Parameters<typeof groupOhlcvByMonth>[0]);
    expect([...byMonth.keys()]).toEqual(["2026-01", "2026-02"]);
    expect(byMonth.get("2026-01")).toHaveLength(2);
    expect(byMonth.get("2026-02")).toHaveLength(1);
  });
});

describe("runResumableVenueBackfill", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** One daily candle per fetchPage call, `limit` of them starting at `sinceMs`. */
  function dailyCandles(sinceMs: number, limit: number): OHLCV[] {
    const candles: OHLCV[] = [];
    for (let i = 0; i < limit; i++) candles.push([sinceMs + i * DAY_MS, 100, 100, 100, 100, 1]);
    return candles;
  }

  it("flushes a month once pagination moves past it, keeping the current month pending", async () => {
    const flushes: Array<[string, number]> = [];
    const checkpoints: number[] = [];

    const { rows } = await runResumableVenueBackfill({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: Date.UTC(2023, 0, 1), // Jan 1
      intervalMinutes: 1440, // 1 day
      limit: 31,
      maxPages: 2,
      nowMs: asUnixMillis(Date.UTC(2030, 0, 1)),
      fetchPage: async (sinceMs, limit) => dailyCandles(sinceMs, limit),
      flushMonth: async (month, monthRows) => {
        flushes.push([month, monthRows.length]);
      },
      onCheckpoint: (lastWrittenMs) => {
        checkpoints.push(lastWrittenMs);
      },
    });

    // Page 1: Jan 1-31 (all one month, nothing flushed yet — could still grow).
    // Page 2: Feb 1 - Mar 3 (28 Feb rows + 3 Mar rows) — Jan and Feb are now
    // behind pagination and get flushed; Mar (the new latest month) stays pending
    // until the run ends, then gets its own final flush.
    expect(flushes).toEqual([
      ["2023-01", 31],
      ["2023-02", 28],
      ["2023-03", 3],
    ]);
    expect(checkpoints).toEqual([Date.UTC(2023, 0, 31), Date.UTC(2023, 1, 28), Date.UTC(2023, 2, 3)]);
    expect(rows).toHaveLength(62);
  });

  it("advances the checkpoint only past durably-flushed months when a later flush fails", async () => {
    const flushes: string[] = [];
    const checkpoints: number[] = [];

    await expect(
      runResumableVenueBackfill({
        exchange: "kraken",
        pair: "TAOUSD",
        sinceMs: Date.UTC(2023, 0, 1),
        intervalMinutes: 1440,
        limit: 31,
        maxPages: 2,
        nowMs: asUnixMillis(Date.UTC(2030, 0, 1)),
        fetchPage: async (sinceMs, limit) => dailyCandles(sinceMs, limit),
        flushMonth: async (month) => {
          flushes.push(month);
          if (month === "2023-02") throw new Error("simulated crash mid-flush");
        },
        onCheckpoint: (lastWrittenMs) => {
          checkpoints.push(lastWrittenMs);
        },
      }),
    ).rejects.toThrow("simulated crash mid-flush");

    // January was durably flushed and checkpointed before the crash; February's
    // flush attempt is recorded but never reached onCheckpoint; March never ran.
    expect(flushes).toEqual(["2023-01", "2023-02"]);
    expect(checkpoints).toEqual([Date.UTC(2023, 0, 31)]);
  });

  it("resumes from the caller-supplied sinceMs rather than re-fetching earlier history", async () => {
    const requestedSinceMs: number[] = [];
    const resumeFromMs = Date.UTC(2023, 5, 15); // as if a checkpoint already covered Jan-May

    await runResumableVenueBackfill({
      exchange: "kraken",
      pair: "TAOUSD",
      sinceMs: resumeFromMs,
      intervalMinutes: 1440,
      limit: 5,
      maxPages: 1,
      nowMs: asUnixMillis(Date.UTC(2030, 0, 1)),
      fetchPage: async (sinceMs, limit) => {
        requestedSinceMs.push(sinceMs);
        return dailyCandles(sinceMs, limit);
      },
      flushMonth: async () => {},
      onCheckpoint: () => {},
    });

    expect(requestedSinceMs[0]).toBe(resumeFromMs);
  });
});

describe("findEarliestAvailableSinceMs", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SINCE_MS = Date.UTC(2023, 0, 1);
  const NOW_MS = Date.UTC(2026, 0, 1);

  it("returns sinceMs unchanged when data is already available there", async () => {
    const result = await findEarliestAvailableSinceMs({
      sinceMs: SINCE_MS,
      nowMs: NOW_MS,
      probe: async () => true,
    });
    expect(result).toBe(SINCE_MS);
  });

  it("returns null when even nowMs has no data", async () => {
    const result = await findEarliestAvailableSinceMs({
      sinceMs: SINCE_MS,
      nowMs: NOW_MS,
      probe: async () => false,
    });
    expect(result).toBeNull();
  });

  it("binary-searches to the real listing date when sinceMs predates it", async () => {
    const listingMs = Date.UTC(2024, 3, 11); // "real" listing date the search must find
    const probedTimestamps: number[] = [];

    const result = await findEarliestAvailableSinceMs({
      sinceMs: SINCE_MS,
      nowMs: NOW_MS,
      toleranceMs: DAY_MS,
      probe: async (ts) => {
        probedTimestamps.push(ts);
        return ts >= listingMs;
      },
    });

    expect(result).not.toBeNull();
    // Within one day of the real listing date, and never earlier than it
    // (never claims data exists before it actually does).
    expect(result!).toBeGreaterThanOrEqual(listingMs);
    expect(result! - listingMs).toBeLessThan(DAY_MS);
    // Logarithmic in the search range, not linear — a 3-year range at
    // 1-day tolerance needs roughly log2(3*365) ≈ 11 probes, not thousands.
    expect(probedTimestamps.length).toBeLessThan(20);
  });

  it("respects maxProbes as a hard safety cap", async () => {
    let calls = 0;
    await findEarliestAvailableSinceMs({
      sinceMs: SINCE_MS,
      nowMs: NOW_MS,
      toleranceMs: 1, // would otherwise keep narrowing almost forever
      maxProbes: 5,
      probe: async (ts) => {
        calls++;
        return ts >= Date.UTC(2024, 3, 11);
      },
    });
    // 2 calls to check the sinceMs/nowMs invariants, then at most maxProbes narrowing steps.
    expect(calls).toBeLessThanOrEqual(2 + 5);
  });
});

describe("runResumableVenueBackfill with gap-skipping", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("searches forward past an empty first page instead of stopping immediately (venue's real listing date is later)", async () => {
    const listingMs = Date.UTC(2024, 3, 11);
    const nowMs = Date.UTC(2024, 3, 20);
    const requestedSinceMs: number[] = [];

    const { rows } = await runResumableVenueBackfill({
      exchange: "coinbase",
      pair: "TAOUSD",
      sinceMs: Date.UTC(2023, 0, 1), // predates the "real" listing date above
      intervalMinutes: 1440,
      limit: 5,
      maxPages: 1,
      nowMs: asUnixMillis(nowMs),
      fetchPage: async (sinceMs, limit) => {
        requestedSinceMs.push(sinceMs);
        if (sinceMs < listingMs) return [];
        const candles: OHLCV[] = [];
        for (let i = 0; i < limit; i++) {
          const ts = sinceMs + i * DAY_MS;
          if (ts > nowMs) break;
          candles.push([ts, 100, 100, 100, 100, 1]);
        }
        return candles;
      },
      flushMonth: async () => {},
      onCheckpoint: () => {},
    });

    // The search made more than one probe (it had to narrow down from the
    // predating sinceMs) before the real pagination fetch ran.
    expect(requestedSinceMs.length).toBeGreaterThan(1);
    expect(rows.length).toBeGreaterThan(0);
    // Never claims data exists before it actually does.
    expect(rows[0]!.timestampMs).toBeGreaterThanOrEqual(listingMs);
  });

  /**
   * Regression test for the real 2026-09-10 stall: a *resumed* run landed
   * exactly on a real ~1-day gap in Coinbase's own history (an empty page,
   * no error) with real data resuming the next day. Every prior rerun
   * stopped there for good — an empty page used to always mean "nothing
   * more," indistinguishable from "already caught up." This must not be
   * scoped to fresh starts only, since a gap can occur anywhere, not just
   * at a venue's listing date.
   */
  it("searches forward past a gap in the middle of otherwise-continuous history on a resume", async () => {
    const gapStartMs = Date.UTC(2025, 9, 25);
    const gapEndMs = Date.UTC(2025, 9, 26); // data resumes the next day
    const nowMs = Date.UTC(2025, 10, 1);

    const { rows } = await runResumableVenueBackfill({
      exchange: "coinbase",
      pair: "TAOUSD",
      sinceMs: gapStartMs, // as if resuming right into the gap
      intervalMinutes: 1440,
      limit: 5,
      maxPages: 2,
      nowMs: asUnixMillis(nowMs),
      fetchPage: async (sinceMs, limit) => {
        if (sinceMs >= gapStartMs && sinceMs < gapEndMs) return []; // the gap
        const candles: OHLCV[] = [];
        for (let i = 0; i < limit; i++) {
          const ts = sinceMs + i * DAY_MS;
          if (ts > nowMs) break;
          candles.push([ts, 100, 100, 100, 100, 1]);
        }
        return candles;
      },
      flushMonth: async () => {},
      onCheckpoint: () => {},
    });

    // Did not stall at zero rows the way the real bug did.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.timestampMs).toBeGreaterThanOrEqual(gapEndMs);
  });

  it("does not search when an empty page means caught up to the live edge", async () => {
    let calls = 0;
    const { rows } = await runResumableVenueBackfill({
      exchange: "coinbase",
      pair: "TAOUSD",
      sinceMs: Date.UTC(2024, 3, 20), // as if resuming from a checkpoint
      nowMs: asUnixMillis(Date.UTC(2024, 3, 20)),
      fetchPage: async () => {
        calls++;
        return []; // caught up to the live edge — genuinely nothing new
      },
      flushMonth: async () => {
        throw new Error("should not flush anything when nothing was fetched");
      },
      onCheckpoint: () => {},
    });

    expect(rows).toEqual([]);
    expect(calls).toBe(1); // exactly one real page attempt, no search probes
  });
});

# tao-tools

TAO analytics pipeline. See [tao-analytics-plan.md](tao-analytics-plan.md) for the full spec.

**Status: Phase 1 (prices and volume — charts 1–3) implemented; Phase 2.1/2.2 (chain tracer
bullet + balance reconciliation) implemented, bronze now writes to real Cloudflare R2. Phase 2.3's
backfill is complete — the full genesis-to-head event index (blocks 1–8,929,643) landed in bronze
2026-09-06, was decoded to silver 2026-09-08, and gold/export were rebuilt across the whole range
2026-09-09.** Every venue is fetched through `ccxt` (§2 stack), including Kraken — the Phase 0
hand-rolled Kraken REST client was migrated in Phase 1. Blockmachine Pro is active.

**`gold.json` was 248MB and unusable in a browser (2026-09-10) — fixed.** Once real price backfill
history landed (previous sections), `price_composite_usd`/`price_composite_btc` alone produced
1,268,539 1-minute points each — a hand-rolled SVG chart (`PriceChart.tsx`, no charting library)
built one path command per point, linear-scanned all of them on every mouse move, and would have
rendered 1.27M `<tr>` rows if the table view were toggled, on top of the 248MB download itself. The
plan's own §9 flags ~5-10MB as where a static JSON export stops working; this was ~25-50x past
that. **Fixed the same way `volume_usd_daily`/`transfer_count_daily` already handle this**: added
`price_composite_usd_daily` and `price_composite_btc_daily` (registry v1, last 1-minute value per
UTC day via `arg_max`), and marked the 1-minute composites `export: false` — still materialized
locally (needed for `price_composite_btc`'s join and any future per-minute join, e.g. Phase 4 cost
basis), just not shipped to the browser. Result: **883 points instead of 1.27M per series,
`gold.json` down to 688KB.** `page.tsx` now points at the `_daily` metrics; a real
`next build` confirms the homepage still statically prerenders. Chart 2's caveat text was also
corrected to actually say "implied, not observed" (previously stale "Composite across Kraken and
Upbit only," left over from before that redefinition).

**Weekly rollups added too (same day)** — confirmed the intended use case is days/weeks, not
1-minute or hourly. Added `price_composite_usd_weekly` / `price_composite_btc_weekly` (127 points
each, built from the daily rollup rather than the 1-minute series — cheaper, and the last day's
close within a week is the same value either way). **Caught a real bug writing these**: the first
attempt used DuckDB's `date_trunc('week', to_timestamp(...))`, which truncates in the DuckDB
session's *local* timezone by default, not UTC — a test comparing against `Date.UTC(...)`-computed
expectations caught a 2-hour offset immediately. Since `materializeGold` could run on any machine,
that would have silently shifted week boundaries depending on where the pipeline happened to run —
a reproducibility bug, not just a test mismatch. Replaced with pure UTC-anchored integer arithmetic
(`((timestamp_ms + 3 days) // 7 days) * 7 days - 3 days`, anchored to the fact that the Unix epoch
was a Thursday, so the preceding Monday is exactly 3 days earlier) — the same style already used
for daily bucketing, just correctly generalized to weeks. `gold.json` is now 729KB across 9 series,
still nowhere near the plan's ~5-10MB comfort line. The chart itself still renders daily by default
(unchanged) — the weekly series are available in `gold.json` for whenever a UI toggle is wanted;
not built yet since it wasn't asked for. Selectable timeframes/candle sizes beyond day/week (zoom
into 1-minute resolution for a recent window, or real OHLC candlesticks instead of a line) would be
a bigger, separate feature.

**Found a real infra gap the same day (2026-09-10): price bronze's full backfill history only
exists locally, not on R2, despite this README's own "bronze now writes to real Cloudflare R2"
line above.** While wiring gold/silver materialization for a new Google Trends source (see "Social
metrics" further down), `pipeline:materialize`/`pipeline:export` and `ingest:check-price-coverage`
turned out to never load `.env` either (the same gap `packages/ingest/src/env.ts` fixed for ingest
scripts) — every past run of these pipeline commands silently fell back to the local `./data/bronze`
stand-in instead of honoring `BRONZE_URI=s3://tao-bronze`, and nobody noticed because the local
stand-in has always had a complete mirror. Checked R2 directly once that was fixed:
`s3://tao-bronze/prices/` has only 721 rows (Kraken's recent live tail) — none of the real
multi-venue backfill (Binance/Coinbase/OKX/MEXC, 4M+ rows total) that's actually only ever lived on
this machine's local disk. **Chain bronze is fine** — `s3://tao-bronze/chain/events/` has the real
8,974,646 rows spanning blocks 1–8,929,643, matching Phase 2.3 exactly; this is specific to price
bronze, most likely from an early `ingest:backfill-prices` run before `BRONZE_URI` was consistently
exported. **Closed the loader gap repo-wide (2026-09-10), not just in `materialize.ts`** — every
script that touches `BRONZE_URI`, R2 credentials, or `BLOCKMACHINE_API_KEY` now calls
`loadEnvFile()` first: `ingest:backfill-prices`, `ingest:kraken`, `ingest:check-price-coverage`,
`chain:ingest`, `chain:backfill`, `spike-g`, `chain:materialize-silver`, `chain:reconcile-balances`
and `chain:reconcile-checkpoints` all previously depended on the invoking shell already having
these exported, silently falling back to defaults (or erroring on a missing API key) otherwise.
`.env` now actually works as documented for every one of them, and **synced all 103 local price
bronze files up to R2 the same day** — every exchange/pair/month file copied via DuckDB `COPY` straight from local to
`s3://tao-bronze/prices/...`, same path layout, same `ZSTD`/1M-row-group settings `writeOhlcBronze`
already uses. Verified two ways: R2 and local now report byte-identical row counts per
exchange/pair, and `pipeline:materialize`/`pipeline:export` run with no `BRONZE_URI` override
(i.e. reading only from R2 via `.env`, the normal path) reproduce the exact same gold/export numbers
as before (`price_composite_usd`: 1,268,539 rows, etc.). Price bronze now has a real cloud copy,
same as chain bronze always did.

**Two small chart-quality fixes the same day (2026-09-10):**

1. **Hover tooltips showed a date with no year.** `PriceChart.tsx` was the only chart still using
   `formatTime` — a relic from when its data was 1-minute resolution and showing hour:minute
   actually meant something; now that it's daily too, that always read "12:00 AM" noise. Removed
   `formatTime` and switched `PriceChart` to `formatDay` (already what `VolumeChart`/
   `TransferCountChart` use for their daily data), and added `year: "numeric"` to `formatDay` itself
   — fixes the missing year across all three charts' tooltips in one change, not just price.
2. **`volume_usd_daily` summed every USD/USDT venue, which made the series internally
   incomparable.** Venues came online at very different points (Binance 2024-04, Coinbase 2025-03,
   OKX 2026-06, MEXC 2026-08) — the daily total jumped every time a new venue's history started,
   not because trading activity actually changed; a day with 1 contributing venue sat right next to
   a day with 4. **Restricted to Binance only** (registry v1→v2) — it's the only venue with volume
   for the whole window (2024-04-11 → today), so every point in the resulting series is now
   comparable to every other, at the cost of undercounting once the other venues are also trading.
   `page.tsx`'s subtitle and caveat text updated to say so explicitly, and to state the currency
   (USD) directly rather than only implying it via venue names.

**Update 2026-09-28: Phase 3 is no longer provisional.** The first full `chain:reconcile-checkpoints`
run reconciled the fold against real on-chain balances to within dust, and seeding it with the
genesis snapshot removed every negative balance — see "Full genesis-to-head run done" and "Genesis
seed" in the reconciliation section below. The rest of this paragraph is the earlier status, kept
for history.

**Phase 3's numbers are still provisional, and this is the one thing blocking the project.**
`chain:reconcile-checkpoints` has never completed against real chain data — only against fixtures
— so nothing in the fold has been checked against on-chain ground truth. There is now concrete
evidence it needs to: on the full index, `account_balances_daily` has **116,930 rows with a
negative balance across 10,620 distinct coldkeys** (~2% of all 505,493), and
`exchange_balances_daily` still bottoms out at **−9,154.6 TAO**. A negative on-chain balance is
impossible; these are the genesis-funded accounts of plan §10 (funded directly in genesis state,
so no `Deposit` event ever fires and the fold starts them at zero). Fixing it needs real
`System.Account` reads — i.e. the same RPC work reconciliation needs. Don't treat wallet counts or
exchange balances as final until that run comes back clean. **Reconciliation is now sized and it's
cheap**: `pnpm chain:estimate-reconciliation-rpc` (new 2026-09-09, no RPC calls) puts the full
genesis-to-head run at **~1.67M RPC calls ≈ 1.67M RU**, well inside Pro's 20M/month quota — budget
was the open question, not a blocker. `chain:reconcile-checkpoints` itself just needs to actually
be run against real chain data next.

## Setup

```
pnpm install
cp .env.example .env
```

Node 22 is what the plan specifies; this was built and tested on Node 20, which also works —
upgrade when convenient, nothing here depends on a 22-only feature.

## Running the pipeline end to end

```
pnpm ingest:kraken               # Phase 0 smoke check: last 24h Kraken TAO/USD -> bronze
pnpm ingest:backfill-prices      # Phase 1: every venue in packages/ingest/src/exchanges/venues.ts,
                                  # full history, with gaps logged to data/meta/ingestion_log.parquet
pnpm pipeline:materialize        # bronze -> silver/ohlcv_1m.parquet -> gold/*.parquet
pnpm pipeline:export             # gold -> data/export/gold.json
pnpm pipeline:cross-rate-check   # sanity check: composite USD ÷ BTC/USD should track composite BTC (§4.1)
pnpm web:dev                     # http://localhost:3000 — renders all three charts from gold.json
```

`ingest:backfill-prices` is a real, potentially long-running pull against the venues in
`ALL_VENUES` — 6 venue/pair combinations as of 2026-09-10 (see the trim below), back to each one's
own earliest available candle. **Bronze backfill for USD-denominated venues is now complete**
(2026-09-10, see the detailed writeup below) — Binance, Coinbase, OKX, and MEXC each have their
full real history through today; Kraken is permanently limited to a live-tail window by its own
API, not a gap to chase further. **The price charts are still near-empty regardless**, because
bronze hasn't been materialized yet: `gold.json` still reflects an old partial pull (587 points
for `price_composite_usd`) until `pipeline:materialize` + `pipeline:export` are rerun against the
now-complete bronze. `price_composite_btc` will stay empty either way — no working TAO/BTC venue
exists yet (see `BTC_VENUES` below). Unrelated to any of the chain work — it's a Phase 1 gap.

**Resumable per venue, checkpointed to `data/meta/price_backfill_checkpoint.json`** (built
2026-09-09, replacing an earlier version that buffered a venue's entire multi-year history in
memory before writing anything). Run it yourself, in your own terminal, so you can watch it live:

```
pnpm ingest:backfill-prices
```

What you'll see: one line per page fetched (`kraken TAOUSD: page 42, +720 candles (reached
2023-06-02T...), 30240 fetched this run.`) and one line whenever a completed month is durably
written to bronze and checkpointed (`kraken TAOUSD: checkpoint saved at 2023-06-01T...`). **Stop it
any time — Ctrl+C, close the terminal, shut down the computer — and rerun the exact same command
later; it resumes each venue from its own last checkpointed month instead of re-fetching from 2023.**
A crash between two checkpoint saves loses at most the one month that was still being assembled
when it died, never anything already flushed. Nine venues run one after another in the same
process, so a restart also correctly skips straight to whichever venue was mid-flight (each venue's
checkpoint is independent — `data/meta/price_backfill_checkpoint.json` is one JSON object keyed by
`exchange:pair`).

To force a full re-backfill for one venue (e.g. after a bug fix in the normalizer), delete that
venue's entry from the checkpoint file, or delete the whole file to restart everything. An explicit
`BACKFILL_SINCE_MS` override only takes effect for a venue that has no checkpoint yet — it can't
silently discard resume progress.

Verified against the real Kraken API (2026-09-09, a 3-hour smoke window, not committed): the real
page-by-page flow — live ccxt call, incremental bronze write, checkpoint save, then a simulated
restart — fetched the expected 180 one-minute candles on the first run and correctly resumed to 0
new candles on the second (already caught up).

**First real user run (2026-09-09) surfaced three distinct failure modes, only one of which is
actually fixable in our code — worth knowing before assuming a low row count means "it crashed":**

1. **Binance worked correctly and can be trusted as-is** — real data from its actual listing date
   (2024-04) through today. No issue.
2. **Kraken and Gate.io cannot serve deep 1-minute history at all, and no amount of retrying
   fixes this.** Kraken's public OHLC endpoint silently ignores an old `since` and just returns
   whatever's most recent — no error, so it *looks* like it worked, but it's a live tail, not
   history (confirmed by direct probe: asking Kraken for `since=2023-01-01` returned today's
   candles). Gate.io is more honest about the same limit: `"Candlestick too long ago. Maximum
   10000 points ago are allowed"` (~7 days at 1-minute resolution). Both venues can still
   contribute to the live edge going forward; neither can backfill 2023-onward 1-minute history.
3. **Coinbase, OKX, and MEXC each have a real, later listing date, but their OHLCV endpoint
   returns an *empty* page for a `since` before it instead of clamping to their own earliest
   candle** (which is what Binance's endpoint does for us automatically). `paginateOhlcv`'s
   "stop on an empty page" rule — correct for "history has ended" — was misreading "history
   hasn't started yet" the same way, permanently stalling these three venues at zero rows on
   every run. **Fixed (2026-09-09):** `findEarliestAvailableSinceMs`
   (`packages/ingest/src/exchanges/backfill.ts`) binary-searches forward from the default anchor
   to find each venue's real earliest candle before paginating, using cheap `limit: 1` probes
   (~10 calls for a 3-year range at 1-day precision). Verified against the real APIs: Coinbase
   now resolves to 2025-03-16, OKX to 2026-07-01, MEXC to 2026-08-10 — all previously stuck at
   zero. Wired in via `mayPredateHistory`, which `backfillPrices.ts` sets `true` only on a venue's
   *first* run (`!checkpoint`) — on a resume, an empty page at the checkpoint's sinceMs correctly
   means "caught up to the live edge," and searching forward there would be wrong.
   Bybit (`"bybit does not have market symbol TAO/USDT"`) and Kraken's `TAO/BTC` entry
   (`"kraken does not have market symbol TAO/BTC"`, contradicting plan §4.1's venue table) are a
   different problem — wrong/missing symbol config in `venues.ts`, not a history-depth issue.
   Upbit's `TAO/BTC` returns 0 candles even for a *recent* window with no error, suggesting no
   real listing/liquidity there.

**A second real bug (2026-09-10), found immediately after the fix above: Coinbase, OKX, and MEXC
each stopped again after fetching only a small amount of data, this time correctly starting from
their real listing dates.** Not a crash — `paginateOhlcv` had a second stopping rule, `if
(raw.length < limit) break` (meant to detect "history exhausted"), that can't tell that apart from
"this venue's API caps its own response below what I asked for." Confirmed directly: asking for
720 candles/page, Coinbase returns 270, OKX 300, MEXC 224 — while Binance and Kraken honor 720 in
full. So the three capped venues stopped for good after their very first page, no matter how much
real history remained. **Fixed:** removed that stopping rule entirely — an empty page (genuinely
"nothing here") and reaching the live edge are the only reliable "stop" signals; a short-but-
nonempty page just means more pages are needed to cover the same span. Verified against the real
Coinbase API: fetching 3 pages at `limit: 720` from just after its listing date now returns 792
candles (270 + 270 + 252) spanning forward correctly, instead of stopping at ~270 after page one.

**Venue list trimmed (2026-09-10)**, based on the failures above. `packages/ingest/src/exchanges/venues.ts`
now drops:
- **Bybit** (`USDT_VENUES`) — no working `TAO/USDT` market under ccxt, confirmed with both an old
  and a recent `since`. Not a history-depth issue; the pair mapping is simply wrong or absent.
- **Gate.io** (`USDT_VENUES`) — hard-capped at ~7 days of history by its own API
  (`"Candlestick too long ago. Maximum 10000 points ago are allowed"`); can't contribute to a
  2023-onward backfill at all.
- **Upbit** (`BTC_VENUES`) — 0 candles even for a recent window, no real listing found.

**`BTC_VENUES` is now empty** — Kraken, the other plan-listed TAO/BTC venue, also has no working
`TAO/BTC` market under ccxt (confirmed with both an old and recent `since`), so dropping Upbit
leaves zero working sources for `price_composite_btc` (chart 2). This isn't new breakage from the
trim — neither venue ever produced real TAO/BTC data — it's just made explicit now instead of two
silently-failing entries. **Chart 2 has no data source until a real TAO/BTC venue is found and
added.**

Kept: Kraken (`TAOUSD`, `BTCUSD` reference), Coinbase (`TAOUSD`), Binance (`TAOUSDT`), OKX
(`TAOUSDT`), MEXC (`TAOUSDT`) — OKX and MEXC both have real, working data despite young listing
dates (2026-07 and 2026-08 respectively); a short history isn't a data-quality problem, it just
means the composite has fewer contributing venues before those dates.

**Checking what's actually in bronze**, rather than re-deriving it from the checkpoint file and a
hand-rolled query each time:

```
pnpm ingest:check-price-coverage
```

Read-only, no RPC — reports each venue's row count, date range, and distinct months present, plus
a summary of any gaps `backfillPrices.ts` already logged to `ingestion_log.parquet` (existed since
Phase 1.2, never actually surfaced anywhere until now). **State as of 2026-09-10, after the fourth
fix below and a rerun (before the fifth fix — see next):**

| Venue | Pair | Range | Rows |
|---|---|---|---|
| kraken | TAOUSD | 2026-08-25 → 2026-09-10 (16d) | 762 |
| coinbase | TAOUSD | 2025-03-12 → 2025-10-25 (228d) | 307,479 |
| binance | TAOUSDT | 2024-04-11 → 2026-09-10 (882d) | 1,269,682 |
| okx | TAOUSDT | 2026-06-30 → 2026-09-10 (71d) | 102,544 |
| mexc | TAOUSDT | 2026-08-11 → 2026-09-10 (29d) | 42,177 |
| kraken | BTCUSD | 2026-09-10 only (0d) | 31 |

Kraken's two rows confirm the known, unfixable limitation above — both stuck at a thin recent
window, not real history. Coinbase's ~20,329 missing 1-minute buckets (out of ~328,000 possible
over its 228-day span, in ~16,800 mostly 1-2-minute gaps, largest 36 minutes) look like ordinary
low-liquidity trading gaps — no trade in a given minute means no candle for that minute — not a bug.

**A fourth real bug, found by comparing two consecutive runs' coverage**: OKX and MEXC's row counts
had *decreased* between runs (impossible for a supposedly-additive backfill), and on-disk file
sizes confirmed it — `2026-09.parquet` was 2.3KB for binance and ~2.2KB for OKX/MEXC, vs.
~800KB/~720KB/~600KB for every other full month. **`writeOhlcBronze` used to be a plain overwrite**,
and `runResumableVenueBackfill` only ever buffers rows fetched *during the current run* — so the
month containing "now" gets revisited across every future resumed run (it's never "closed" like an
earlier month is), and each revisit silently replaced the whole file with just that run's small
increment, discarding everything earlier runs had written for the same month. **Fixed:**
`writeOhlcBronze` (`packages/ingest/src/bronze/writer.ts`) now reads whatever's already at the
destination (if anything) and merges it with the new rows, deduplicated by `timestamp_ms`, before
writing — a brand-new month (no existing file) behaves exactly as before. 4 new tests in
`test/writer.test.ts` lock this in, including the exact regression shape (a small second write must
not shrink the file). Binance, OKX, and MEXC's September checkpoints were rolled back to
2026-09-01 (in `data/meta/price_backfill_checkpoint.json`, not committed) so a rerun re-fetched and
correctly merged September's actually-lost days back in — the table above already reflects that
recovery (binance went from 1,256,413 to 1,269,682, etc.).

**A fifth real bug, found because Coinbase stayed at exactly 307,479 rows across three consecutive
reruns** — not a crash, a specific empty page with no error, confirmed by probing the exact resume
point directly (`2025-10-25T15:13:00Z`: 0 candles) and finding real data resumes the very next day.
Same failure class as the "empty page at listing date" fix from before, just occurring *mid-history*
on a *resume* instead of at the very start — and the original fix only searched forward on a fresh
run, since an empty page on a resume is normally the correct, frequent signal for "caught up to the
live edge." Those two cases turned out to need the same underlying handling, just triggered
differently: **generalized (`withGapSkipping` in `backfill.ts`)** — any empty page still
meaningfully behind `nowMs` (not just a first-run page) now searches forward via
`findEarliestAvailableSinceMs` before giving up; an empty page already at/near the live edge is left
alone exactly as before, so this costs nothing extra on the common "already caught up" case that
happens on nearly every resumed run. The old `mayPredateHistory` option is gone — this subsumes it.
Verified against the real stuck point: `runResumableVenueBackfill` from `2025-10-25T15:13:00Z` now
returns 596 real candles starting the next day, instead of the 0 it was stuck on for three runs.
2 new tests in `backfill.test.ts` (16 total) cover both the original and the mid-history shape.

**Confirmed fixed for real (2026-09-10, after a rerun): Coinbase jumped from 307,479 rows (stuck at
2025-10-25) to 741,456 rows, now spanning 2025-03-12 through today** — fully caught up alongside
Binance, OKX, and MEXC. **This is the actual end state for Phase 1.2's backfill**, not another
partial run: every venue with retrievable history now has its full history.

| Venue | Pair | Range | Status |
|---|---|---|---|
| binance | TAOUSDT | 2024-04-11 → today | Fully caught up |
| coinbase | TAOUSD | 2025-03-12 → today | Fully caught up |
| okx | TAOUSDT | 2026-06-30 → today | Fully caught up |
| mexc | TAOUSDT | 2026-08-11 → today | Fully caught up |
| kraken | TAOUSD | 16 days only | Permanent venue limit (§4.2/above) — live tail only |
| kraken | BTCUSD | today only | Permanent venue limit — live tail only |

Kraken's two thin rows are not a bug to keep chasing — confirmed multiple times that its public
OHLC endpoint simply doesn't serve deep 1-minute history, no error, just recent-window-only data
regardless of `since`. It still earns its place in the composite for current/recent-day pricing.

**The reference BTC/USD venue had the same limitation, fixed the same way (2026-09-10).**
`reference_btc_usd` (the BTC/USD leg of the cross-rate check, §4.1 — not a chart) only had
Kraken's `BTC/USD`, which turned out just as thin as Kraken's TAO pairs — `since=2023-01-01`
returns today's candles, not real history. Checked Binance as an alternative: its own `BTC/USD` is
real but only listed since ~2025-12 (same "thin recent pair" shape, just less severe), while its
`BTC/USDT` has full deep history back to at least 2023-01-01 — confirmed directly, a
`since=2023-01-01` fetch returns candles starting exactly there. Added `binance:BTCUSDT` to
`REFERENCE_VENUES` (`venues.ts`) and widened `reference_btc_usd`'s SQL from `pair = 'BTCUSD'` to
`pair IN ('BTCUSD', 'BTCUSDT')` — the same USDT-as-USD-equivalent treatment `price_composite_usd`
already uses (registry version bumped 1→2 per §8's rule). Kraken stayed in rather than being
swapped out — its thin recent data doesn't hurt anything and still contributes real current-day
pricing.

**Chart 2 (`price_composite_btc`) redefined as an implied cross-rate (2026-09-10)** — no reputable
exchange lists a real, continuously-tradable TAO/BTC pair at all (confirmed: Kraken's market list
has no `TAO/BTC` symbol; Upbit returns zero candles even for a recent `since`, no error), so
`BTC_VENUES` stays empty rather than chasing a venue that doesn't exist. Instead of leaving chart 2
permanently blank, `price_composite_btc` (registry v1→v2) is now constructed as
`price_composite_usd ÷ reference_btc_usd` — the same synthetic-cross-rate technique a trader would
use to price an illiquid pair by routing through a common quote currency, using the two real
composites the backfill above already produced. **Always labeled "implied," never presented as an
observed price** — same discipline as chart 5's "estimated cost basis" (plan §7.3: never "MVRV").

Wired via the registry's existing `depends_on` mechanism (`materializeGold` already exposes each
dependency's materialized gold output as a queryable view of the same name — no new machinery
needed, just `depends_on: [price_composite_usd, reference_btc_usd]` and a `JOIN`). **This retires
`pipeline:cross-rate-check`'s original purpose**: it used to compare an independently-sourced
TAO/BTC price against the implied `TAO/USD ÷ BTC/USD` ratio and flag a real divergence between
them; now `price_composite_btc` *is* that ratio by construction, so the check can never find
anything to flag again, for any input — `crossRateCheck.query.test.ts` was rewritten to assert
exactly that (the derivation is correct, and divergence detection is now a structural no-op) rather
than the old "flags a planted 5% drift" behavior, which is no longer producible now that there's no
more independent value to drift from the implied one. `volumeAndBtcComposite.query.test.ts`'s
`price_composite_btc` case was also rewritten — it used to seed raw `TAOBTC` OHLCV rows directly;
now it stands up `price_composite_usd`/`reference_btc_usd` as fixture views, matching how
`depends_on` actually wires a metric to its dependencies.

**Not yet done**: the web chart itself (`packages/web/components/PriceChart.tsx` and friends) still
needs an "implied" label surfaced wherever chart 2 renders, so a viewer never mistakes it for an
observed market price — left alone here since those files are mid-edit in an unrelated, already
in-progress change.

`pnpm test` runs the full suite (unit, query, contract, golden-file — see plan §5).

### Phase 2.1/2.2 — chain tracer bullet

```
pnpm chain:ingest                    # blocks 1-1000 (default): raw System.Events + Timestamp.Now -> R2 bronze
pnpm chain:materialize-silver        # bronze chain/* -> silver/transfers.parquet + balance_events.parquet
pnpm pipeline:materialize            # (as above) now also produces gold/transfer_count_daily.parquet
pnpm pipeline:export
pnpm chain:reconcile-balances        # folds silver into a BalanceMap, checks it against real System.Account reads
```

`FROM_BLOCK`/`TO_BLOCK` env vars override the default 1–1000 range on both `chain:ingest` and
`chain:reconcile-balances` — keep them in sync. Reconciliation seeds the fold from a real
`System.Account` snapshot at `FROM_BLOCK - 1` (not an assumed-empty balance map), so it's correct
for any range, not just one starting at genesis — see the "genesis-funded accounts" trap below.

**Results, run 2026-08-26, blocks 1–1000 (the chain's first ~3 hours):**
- 1,000/1,000 blocks had non-empty `System.Events`, but only 2 `Balances.Transfer` and 59
  `Balances.Deposit`/`Withdraw` events in total — most activity is `System`, `SubtensorModule`
  (`AxonServed`, `WeightsSet`), and `TransactionPayment` (fees were 0 in this window, so no balance
  moved from those). `transfer_count_daily` (per-block at the time, since renamed and rebucketed —
  see plan §6) was a near-empty series (2 points) — correct, not a bug; this window mostly proves
  the decode path, not real transfer volume.
- **`chain:reconcile-balances` found a real gap on the first run**, not a clean pass: several
  coldkeys already held tens of thousands of TAO *at block 0*, before any event fires for it
  (genesis state is constructed directly, not via extrinsics — see the new trap in plan §10). The
  fold itself was correct; it was seeded from the wrong baseline. Fixed by seeding from a real
  `System.Account` read at `FROM_BLOCK - 1` instead of an empty map. After the fix: **all 33
  touched coldkeys reconcile exactly** against real `System.Account` reads at block 1000.
- The decode path itself is exercised by real recorded fixtures in `fixtures/chain/` (a real block
  with 17 non-balances events, decoded and correctly filtered to nothing), independent of whether
  this particular block range has transfer activity.

`chain:ingest` is rate-limited to the free tier's measured 50 CU/min (paced to 40, see plan §4.2)
— 1,000 blocks takes roughly 75 minutes. It's meant to run as a background process, not
interactively.

### Phase 2.3 — full event index backfill (complete)

```
pnpm chain:backfill    # genesis (or FROM_BLOCK) -> chain head (or TO_BLOCK), chunked + resumable
```

**Done 2026-09-06: blocks 1–8,929,643 are in bronze**, run across many sessions off the checkpoint
below at a measured 3.0 calls/block, so **~26.8M RPC calls in total**. (Careful reading the logs:
the script's call counter resets on every process start, so `backfill.log`'s closing "569,181 RPC
calls" is just the final session — that one covered blocks 8,740,001–8,929,643. Multiply blocks by
3 for the real figure, not the log line.) Decoded to silver 2026-09-08 — 102,358,339 transfers
(after removing the 1,447 duplicates described below), 235,553,651 balance events, 3,306,536 stake
events. That run actually skipped 16 blocks on decode failure (logged to
`data/meta/materialize_silver_skipped_blocks.jsonl`), not the two this line used to say. All 16
turned out to be runtime-upgrade blocks decoded with the wrong metadata, since fixed and repaired
(2026-09-28, see "Runtime-upgrade blocks" below). The skip path itself is still deliberate, see
`materializeChainSilver`'s catch: a single block failing to decode must not halt the other ~9M.

Env vars: `FROM_BLOCK` (default 1), `TO_BLOCK` (default: live chain head), `CHAIN_CHUNK_BLOCKS`
(default 100,000 — one bronze file per chunk, split further only at a runtime-upgrade boundary),
`CHAIN_MAX_RPM` (default 40 — the free-tier-safe pace from Phase 2.1/2.2; raise this toward Pro's
real cap, see below), `CHAIN_CONCURRENCY` (default 1 — see below, this one matters a lot).

Unlike `chain:ingest`, this script detects runtime upgrades per chunk (binary search over
`state_getRuntimeVersion`, not a check per block) and stamps each bronze row with the spec_version
actually active for it, caching each new metadata blob as it's discovered. It checkpoints to
`data/meta/chain_backfill_checkpoint.json` after each chunk's bronze write, so killing and
re-running the same `FROM_BLOCK`/`TO_BLOCK` resumes rather than restarting.

**`CHAIN_CONCURRENCY` — do not run a real pull at the default of 1.** A sequential sample
(`CHAIN_CONCURRENCY=1`) on Pro is network-latency-bound, not rate-limit-bound: ~6.85 calls/s
against a 33/s cap, projecting to ~45 days for the full ~8.9M-block range. Raising concurrency
fixes that — but multiple follow-up samples (2026-08-26, concurrency 20/30/80/200, see plan §6)
converged on a **~110-120 calls/s sustained ceiling regardless of concurrency**, including after
replacing the client's rate limiter with a smoother token-bucket design that made no difference —
strong evidence it's a soft, non-429 throttle on Blockmachine's side, not anything tunable here.
**Realistic full-backfill estimate: ~65-70 hours (~2.7-3 days)** at `CHAIN_CONCURRENCY` anywhere
from ~30 to ~80 (higher concurrency past that point doesn't help).

**Also confirmed and fixed during sampling — real risks to a full run:**
- `parquetWriter.ts` used to build the entire bronze payload as one JS string before writing it;
  a large-event-payload block range blew past V8's string-length ceiling
  (`RangeError: Invalid string length`). Fixed by streaming the write.
- That fix initially leaked the temp staging file on a write failure (found via a real `ENOSPC` —
  **the write host's disk was nearly full, independent of this work**: check free space before a
  real run, some ranges produce staging files well over 100s of MB and the full backfill's default
  100,000-block chunks will be larger still). Fixed by widening the cleanup `finally`.

**Still open, independent of the backfill itself:** read the actual RU cost off the Blockmachine
dashboard to confirm the ~13.5–27M RU projection — see plan §4.2 and §6. The budget running out
on 2026-09-05 is itself a measurement, and the plan's own worry looks confirmed: it was exhausted
at block 6,440,000, i.e. ~19.3M backfill calls plus ~192,000 sampling ≈ **19.5M calls against
Pro's 20M RU quota, so roughly 1 RU per call**. At 3 calls/block that puts the full backfill near
**~26.8M RU**, over Pro's monthly quota — exactly the overshoot §4.2 flagged when the design went
from 2 to 3 calls per block. Steady state is not a concern by the same arithmetic: 7,200
blocks/day × 3 ≈ 650K RU/month, well inside Standard.

**If the backfill stops for any reason** (crash, closed terminal, computer restart): rerun the
exact same command with the same `FROM_BLOCK` and `TO_BLOCK` left unset. It reads
`data/meta/chain_backfill_checkpoint.json` and resumes from the next block after
`lastCompletedBlock` — `TO_BLOCK` is resolved once (the live head at first run) and pinned in the
checkpoint from then on, so a restart won't recompute a different head and fail to match it.

### Decoding bronze -> silver at full scale

`chain:materialize-silver` is pure local DuckDB/CPU work — no RPC, no RUs — but it is hours of it
against the full range, so it's resumable: a persistent staging DB in `data/silver/` plus a JSON
checkpoint in `data/meta/`. Stop it and rerun the same command to continue. `MATERIALIZE_SILVER_BATCH_BLOCKS`
(default 3,000) and `MATERIALIZE_SILVER_FLUSH_INTERVAL_BATCHES` (default 500) tune it.

Three things learned running it end to end (2026-09-07/08), all fixed, all worth knowing before
the next long run:

- **The resume used to be non-idempotent, and it silently corrupted silver.** A batch inserts
  transfers, then balance_events, then stake_events, and only *then* advances the checkpoint — so a
  process killed between the first two inserts left transfer rows committed for blocks the
  checkpoint didn't know about, and the rerun inserted them again. Found for real: 1,447 duplicated
  `(block_number, event_index)` transfer rows in blocks 5,425,008–5,427,996, with that batch's
  balance_events clean. Duplicates aren't just extra rows — a repeated transfer permanently shifts
  that coldkey's running balance for the rest of history. Resuming now deletes anything at or past
  the resume point first. If you suspect an older silver build, check with
  `SELECT block_number, event_index, COUNT(*) FROM read_parquet('data/silver/transfers.parquet') GROUP BY 1,2 HAVING COUNT(*) > 1`,
  and repair inside the **staging DB**, not just the parquet — silver/*.parquet is re-exported from
  it on every run, so fixing only the parquet puts the duplicates straight back.
- **The periodic parquet flush re-exported the whole table, not just new rows**, so it got steadily
  more expensive: 327s -> 817s per flush, with per-batch time drifting 150s -> 680s across one run.
  Raising the interval took the tail of the run from ~5 blocks/s back to ~37 blocks/s.
- **A hard power-off can leave the JSON checkpoint the right length but full of NUL bytes** (the
  rename lands, the written bytes never flush). The staging DB survives that — it's transactional —
  so the recovery is to read the real progress out of it
  (`SELECT MAX(block_number) FROM transfers`, which lands on a batch boundary) and rewrite the
  checkpoint to match, rather than redecoding from scratch.

**A fourth thing, found for real 2026-09-11 by actually running `chain:reconcile-checkpoints` against
live chain data for the first time (see that section below): `Balances.DustLost` was never decoded,
and it should have been from the start.** Substrate reaps an account once a balance mutation drops
its free balance below the existential deposit, emitting `DustLost { account, amount }` for the exact
remaining balance it sweeps to zero — same two-field shape as `Withdraw { who, amount }`, but
`decodeEvents.ts`/`normalize.ts` only ever handled `Transfer`/`Deposit`/`Withdraw`. An account that
gets reaped kept a phantom leftover balance in the fold forever. Confirmed against a real block
(mainnet 9809, spec_version 107, `fixtures/chain/block-9809-dustlost.json`): a coldkey with a real
9,999,712-rao baseline, a 143-rao fee withdraw, a `DustLost` of the exact 1-rao remainder, then a
9,999,568-rao transfer out — the fold without `DustLost` reconstructed balance 1; the real chain says
0. **Fixed by normalizing `DustLost` to a `withdraw` `BalanceEvent`** (`normalizeBalanceEvent` in
`packages/core/src/events/normalize.ts`, extraction in `decodeEvents.ts`) — no core-reducer change
needed, since debiting the swept amount is exactly what reaping does. Verified against real data at
small scale: reconciling blocks 1-20,000 against a freshly-materialized silver (built from a local
mirror of that block range's real bronze) went from **5,080 mismatches to 0** across 6,383 touched
coldkeys. **The real, full-range `data/silver/balance_events.parquet` still predates this fix** — it
was built before `DustLost` was decoded, so `chain:materialize-silver` needs a full rerun (hours,
local-only, no RPC) before the full-range reconciliation reflects it. Until then, expect the full
reconciliation run's mismatch count to be dominated by this now-fixed-in-code-but-not-yet-
re-materialized gap, not by anything still genuinely wrong with the fold.

**Runtime-upgrade blocks were decoded with the wrong metadata (found and fixed 2026-09-28).**
Bronze stamps each block with `state_getRuntimeVersion` at that block's hash, which is the runtime
*after* the block ran. That's right for every block except an upgrade block: its events were
emitted by the old runtime, since new code only runs from the next block. So all 168 upgrade blocks
were decoded one version too early. 16 of them failed outright and were skipped, silently dropping
739 transfer/balance/stake rows from silver (up to 263 in one block). The other upgrade blocks only
decoded because the relevant types happened not to change. A 2026-08-29 investigation had ruled
this out because bronze's stamp matched a live read, but the live read reports the post-block
runtime too. Also found: blocks 561-1000 have two bronze rows with different stamps (the Phase 2.1
tracer bullet stamped all of 1-1000 as 101, the upgrade-aware backfill stamps 561+ as 102). Events
bytes are identical across every one of the 45,003 duplicated blocks; only the stamp differs, and
the decoder had been picking one of the duplicate rows arbitrarily.

**Fix** (`DecodeSpecPlan` in `materializeChainSilver.ts`): a block's version is the highest stamp
among its duplicate rows, and a runtime-transition block decodes with the previous block's version.
A version that goes backwards fails loudly, since that can't happen on-chain. **Repair**:
`pnpm --filter @tao-tools/pipeline run chain:repair-silver-upgrade-blocks` re-decodes just the
affected blocks (transitions plus conflicting stamps, 607 in total) in the existing staging DB, in
one transaction, decoding everything before deleting anything, then re-exports silver. On the real
data it changed exactly the 16 previously-skipped blocks (0 rows each before) and left the other
591 byte-identical, so no block had been silently mis-decoded. Covered by
`materializeChainSilverUpgradeBlocks.test.ts`, using real mainnet block 720,235 (upgrade 122 -> 123).

**Why the tail of the chain is so slow to decode, and why transfer counts exploded (2026-09-27).**
The rebuild above ran at ~30s per 3,000-block batch until block 8,283,000, then stepped to
~180-250s and stayed there. Not a regression (the flush-interval fix above is intact): subtensor
runtime 411 went live at block 8,283,784, and average `System.Events` size per block jumped ~4x
(~6 KB to ~25 KB). Starting the very next block, the runtime sweeps each subnet's `subtensr`
pallet sub-account into the main `subtensr` account, ~200 `Balances.Transfer`s per block. June
2026 alone has 42.8M transfers, ~99% of them touching a pallet account, against ~350K/month of
ordinary transfers, so ~40% of all transfers in chain history sit in the last two months or so.
`transfer_count_daily` v2 showed that as an 80x activity surge. **Split in registry v3:**
`transfer_count_daily` now counts only transfers with no pallet-derived account on either leg, and
the rest moved to `transfer_count_protocol_daily`. Pallet accounts are identified by decoding each
distinct transfer leg's SS58 address (`palletIdOf`, `packages/core/src/chain/palletAccount.ts`: a
32-byte account id starting with `modl`), exposed to registry SQL as a `pallet_accounts` table
that `materializeGold` builds only when an entry references it. Wallet counts are unaffected, since
pallet accounts are a handful of the 505K coldkeys.

### Phase 2.3 — reconciliation checkpoints

```
pnpm chain:reconcile-checkpoints    # incremental reconciliation, genesis -> UP_TO_BLOCK
```

Required env: `UP_TO_BLOCK` — the block `chain:materialize-silver` has actually decoded up to
(check the chain backfill checkpoint's `lastCompletedBlock` — `data/meta/chain_backfill_checkpoint.json`
locally, or `chain/meta/backfill_checkpoint.json` in R2 if `BRONZE_URI` is `s3://` (see
`packages/ingest/src/chain/r2Checkpoint.ts`) — then confirm silver was re-materialized against that
bronze), **not** the live chain head. Optional: `FROM_BLOCK` (default
1), `CHECKPOINT_INTERVAL_BLOCKS` (default 216,000, ≈30 days at 12s/block), `CHAIN_MAX_RPM` (default
40), `CHAIN_CONCURRENCY` (default 1 — see below, do not run a real pass at the default).

**`CHAIN_CONCURRENCY` — added 2026-09-11, and matters here for the same reason it did for
`chain:backfill`.** `reconcileBalances`'s two `state_getStorage`-per-coldkey passes (fresh
baselines, then final balances) used to await one coldkey at a time — latency-bound at ~270ms/call
RTT (§4.2/§6's finding, same root cause), not rate-limit-bound. At concurrency 1 the estimated
1,674,167-call full run (see below) projects to **~5 days of wall-clock time**, even though the RU
cost is only ~8% of Pro's monthly quota — budget was never the real constraint here, throughput was.
Fixed the same way `fetchBlockRange.ts` fixed it for the backfill: both passes now run through a
small order-preserving worker pool (`mapWithConcurrency`, `packages/pipeline/src/chain/concurrency.ts`,
covered by `concurrency.test.ts` and a `reconcileBalances.test.ts` case asserting overlapping
in-flight calls produce identical results to sequential). Set `CHAIN_CONCURRENCY` the same way the
backfill did (`CHAIN_MAX_RPM=11500 CHAIN_CONCURRENCY=50`, or similar) — untested against a real
sustained run yet, so measure a short real window before committing to the full range; the
backfill's own ~110-120 calls/s ceiling is a reasonable planning number but reconciliation's call
shape (single `state_getStorage` reads, not two-calls-per-block) hasn't been confirmed to hit the
same ceiling.

**Cross-run checkpointing — also added 2026-09-11, before any real run was attempted.** Before this,
a restart re-verified every earlier window from scratch (no persistence across invocations at all) —
tolerable for a fixture-backed test, not for a run spending real RU on every `state_getStorage` call
it repeats. `data/meta/reconciliation_checkpoint.json` (`packages/pipeline/src/chain/
reconciliationCheckpoint.ts`) now persists `lastCompletedWindowEnd` and the validated
`knownGoodBalances` map after every window (`onWindowComplete`, wired in the script). A rerun with
the same `FROM_BLOCK`/`CHECKPOINT_INTERVAL_BLOCKS` picks up at the next window instead of redoing
completed ones — keyed on those two values only, **not** `UP_TO_BLOCK`, so (mirroring
`chain:materialize-silver`'s own checkpoint) rerunning later with a larger `UP_TO_BLOCK` as the
backfill/silver progresses just reconciles the newly-reachable windows on top of what's already
validated. An unreadable (e.g. power-loss-corrupted) checkpoint is treated as "no checkpoint" and
restarts from `FROM_BLOCK`, same recovery as the gold-shard and silver-materialization checkpoints.
Covered by `reconciliationCheckpoint.test.ts` (round-trip, range mismatch, corruption recovery) and
new `runReconciliationCheckpoints.test.ts` cases (`resumeFrom` skips completed windows;
`onWindowComplete` fires once per window with the right balance state).

This walks consecutive, non-overlapping windows from genesis to `UP_TO_BLOCK`, reconciling each
against real `System.Account` reads the same way `chain:reconcile-balances` always has — but
threading each checkpoint's validated balances into the next one (`knownGoodBalances`) instead of
re-fetching a real on-chain balance for every coldkey at every checkpoint, or re-folding the whole
history from genesis each time. `reconcileBalances` itself had a real bug fixed alongside this
(2026-08-26): it used to fold *every* event currently in silver regardless of the requested window,
which only happened to be correct because it had only ever been called with `fromBlock = 1`
(Phase 2.2) — any later, non-genesis checkpoint would have double-counted every event before its
window. Events are now filtered to the requested `[fromBlock, toBlock]` before folding.

**Still never run against real chain data — this is the project's blocker.** Only validated with
fixture-backed tests (`packages/pipeline/test/reconcileBalances.test.ts`,
`runReconciliationCheckpoints.test.ts`) using the recorded real metadata in `fixtures/chain/`.
The prerequisite is now met: silver covers the whole range, so `UP_TO_BLOCK=8929643` is correct.
What's left is RPC budget and an honest estimate of the call count — this walks ~41 windows of
216,000 blocks and re-verifies every earlier window on each invocation, against 505,493 distinct
coldkeys, and has never been sized at that scale. Estimate the reads before spending budget:

```
pnpm chain:estimate-reconciliation-rpc    # UP_TO_BLOCK required, no RPC calls made
```

`packages/pipeline/src/scripts/estimateReconciliationRpc.ts` (logic in
`packages/pipeline/src/chain/estimateReconciliationRpc.ts`, tested against a fixture in
`estimateReconciliationRpc.query.test.ts`) mirrors `reconcileBalances`'s own touched/newly-touched
accounting exactly, as a single DuckDB query over `silver/transfers.parquet` and
`silver/balance_events.parquet` — no network access, no `BLOCKMACHINE_API_KEY` needed. It buckets
every transfer leg and balance-event coldkey by which `CHECKPOINT_INTERVAL_BLOCKS` window its
block falls in, then counts, per window, the touched coldkeys (one `state_getStorage` read each,
every window they're touched in) and the newly-touched ones (a second read, but only the first
window a coldkey is ever seen — `knownGoodBalances` carries it forward for free after that).

**Run 2026-09-09 against the full range (`UP_TO_BLOCK=8929643`, default 216,000-block windows,
41 complete windows):** 1,181,375 actual-balance reads + 492,669 baseline reads + 123 window-
overhead calls (hash/runtime-version) = **1,674,167 total RPC calls**, i.e. **~1.67M RU at the
~1 RU/call measured in §4.2** — about 8% of Pro's 20M monthly quota, nowhere near the backfill's
~26.8M. Reconciliation is cheap relative to the backfill precisely because the same 505,493
coldkeys keep recurring across the 41 windows rather than each window paying a fresh baseline read
for all of them (492,669 total baseline reads vs. 505,493 distinct coldkeys — nearly 1:1, as
expected since most coldkeys are touched for the first time somewhere and rarely again before
that; the 1.18M actual reads are the real multiplier, averaging ~29K touched coldkeys per window
but climbing well past that in the busier later windows). **Budget is not the blocker here** — this
comfortably fits in a single month's Pro quota alongside room to spare; the earlier "size before
spending" caution was warranted (it wasn't obvious a priori that 41 × 505K would stay this small)
but the answer is a green light, not a further blocker.

**First real run against live chain data, 2026-09-11 — small samples only, not the full range yet,
but this is what `chain:reconcile-checkpoints` has been waiting on since Phase 2.3 closed.** Two
things fell out of actually running it for the first time:

1. **The concurrency and checkpoint fixes above both held up.** Blocks 1-10,000 (5,659 touched
   coldkeys) reconciled cleanly at `CHAIN_CONCURRENCY=50`; a second invocation with a larger
   `UP_TO_BLOCK` correctly skipped that window (0 new RPC calls for it) and only processed the next
   one, finishing in ~9s wall time.
2. **It immediately found the real `DustLost` decoding gap documented above** — 5,080 mismatches
   across those same two windows before the fix, 0 after, once reconciled against a freshly
   `DustLost`-inclusive silver. This is exactly what reconciliation is for; the sample run did its
   job on the first real attempt.

**Full genesis-to-head run done 2026-09-28: the fold reconciles.** 42 windows of 216,000 blocks
(genesis to 9,072,000), `CHAIN_CONCURRENCY=50`, 1,755,531 RPC calls in ~2.5h (~190 calls/s, well
above the backfill's ~110-120). Every window through block 4,968,000 reconciled exactly; after that,
**319 mismatches across 248 coldkeys out of ~1.23M coldkey checks (~0.03%)**, all dust-sized:
largest 0.0095 TAO, median a few thousand rao, net 0.005 TAO summed. None are pallet accounts.
About 78% have the fold too high (a missing small debit) and the same amounts recur (4,680 rao x17,
660 x14, 4,575 x13), which points at a fixed fee or burn emitted as a balances event type not yet
decoded in newer runtimes. Not yet identified. The full per-window output, with every mismatch's
free/reserved split, is in `reconcile-full.log` (local, gitignored).

Getting there needed three fixes to the reconciler itself, none of which the 20K-block samples could
surface:
- **It loaded every event in silver into one JS array up front** (~370M objects at full scale) and
  folded them with a reducer that copies the whole balance map per event. Each window now gets its
  per-coldkey net change from DuckDB (`loadWindowNetDeltasFromSilver`); only end-of-window balances
  are compared, so the net sum is exactly what the fold would end on.
- **It carried reconstructed balances forward**, so one gap cascaded into every later window. It
  now carries the actual on-chain balance just read, so each window independently tests the fold and
  a mismatch points at the window it came from.
- **It decoded `System.Account` with polkadot.js's built-in `AccountInfo`**, which assumes 128-bit
  balances; Bittensor's are 64-bit, so any account holding a reserve read as free + reserved x 2^64
  (found at window 9: ~1.8e28 rao). `decodeAccountBalances` now uses the runtime metadata's own
  storage type. Reconciliation compares against **free + reserved**: the fold never sees free <->
  reserved moves (identity deposits, registrations...), so the total is what it actually tracks.

Reconciliation seeds each coldkey from a real on-chain read the first time it's touched, so it proves
the *event set* complete (to dust) but didn't by itself fix `account_balances_daily`, which folded
from zero and showed ~117K negative-balance rows across ~10.6K coldkeys.

**Genesis seed (2026-09-28): negatives gone.** Finney launched with **18,619 accounts holding ~1.82M
TAO directly in genesis state**, and no event ever credits those. `chain:snapshot-accounts`
(`packages/ingest`, `SNAPSHOT_BLOCK` default 0) lists every `System.Account` key at the block and
fetches the values in batches (59 RPC calls for genesis) into
`bronze/chain/account_snapshots/{block}.parquet`, raw. `pipeline:materialize` decodes it to
`silver/account_snapshots.parquet` (free + reserved, against that block's metadata), and
`account_balances_daily` v3 adds each coldkey's block-0 balance as its first delta. Before building
it, every one of the 10,581 still-negative coldkeys was checked to be a genesis account whose seed
brings it back to >= 0; after the rebuild there are **0 negative rows**, the exchange-balance
series never drops below 37,062 TAO (was -9,154.6), and the wallet count starts at **18,607** on
genesis day instead of 8. It then drops to 14,282 the next day, which is real: 4,392 genesis dust
wallets (median ~0.001 TAO, 320 TAO total) were emptied on 2023-03-21, 4,370 of them into one
address (`5EsyFE...gq1`), each paying a fee and having its last few rao reaped. `wallet_count_*` and
`exchange_balances_daily` got a version bump for the changed input (definitions unchanged).

With the event set reconciled and the genesis baseline in, **Phase 3's wallet counts and exchange
balances are no longer provisional** — the remaining known error is the ~0.005 TAO of dust
mismatches above. Wallet-count series 2 (stake > 0) is still unbuilt.

### Sharded gold metrics (`shard_by`)

A registry entry may set `shard_by: <output column>`. The runner then computes that metric one
hash-bucket of the column at a time — narrowing the silver views to the bucket, running the
entry's SQL *verbatim*, keeping only that bucket's output rows, and writing one part file per
bucket before concatenating them. `GOLD_SHARD_COUNT` (default 64) sets the bucket count.

This is only valid when every window/group in the entry's SQL partitions by that column, so a
bucket's rows are computable without seeing any other bucket's — set it anywhere else and the
output is silently wrong, not just slow. `account_balances_daily` qualifies; nothing else currently
does.

What it buys, and why it exists: the metric used to run as one statement over ~440M delta rows and
could not finish against the full index — 2h48m and then 4h+ without completing, ~186GB of spill,
and two outright temp-directory exhaustions, all while reporting nothing (DuckDB's query-progress
API returns no estimate for that query shape). Sharding gives bounded memory, an honest
`shard 12/64 complete (18.8%), 4m12s elapsed, ~14m remaining` line, and a checkpoint per bucket so
a shutdown costs one bucket rather than the whole run. Progress lives in
`data/meta/gold_shard_checkpoint_<metric>.json` and parts in `data/gold/<metric>.parts/`; both are
cleared once the metric assembles. A checkpoint is only reused when a fingerprint over the metric's
SQL *and* the silver files it actually reads still matches, and only for buckets whose part file is
genuinely on disk.

Note that sharding alone was not what made this tractable — it isolated the problem but couldn't
solve it, because hash bucketing balances *keys*, not *rows*, and one pallet-derived account holds
~44% of all transfer legs (~91M rows) in a single unsplittable partition. That bucket still ran 4+
hours. What fixed it was `account_balances_daily` v2 (aggregate per (coldkey, day) *before* the
running sum, see the registry changelog), which collapses that account to ~91 daily rows. Full run
is now 7m11s.

### Venues (Phase 1, §4.1)

| Pair | Venues | Registry metric |
|---|---|---|
| TAO/USD, TAO/USDT (folded in as USD-equivalent) | Kraken, Coinbase, Binance, Bybit, OKX, MEXC, Gate | `price_composite_usd` |
| TAO/BTC | Kraken, Upbit | `price_composite_btc` |
| BTC/USD (reference only, not a chart) | Kraken | `reference_btc_usd` |

Daily USD volume (`volume_usd_daily`) sums quote volume across the same USD/USDT venues.
`reference_btc_usd` is registered with `export: false` — it materializes to gold like any other
metric but never ships in `gold.json`; it only feeds `pipeline:cross-rate-check`.

The live rightmost-pixel edge on the TAO/USD chart (`packages/web/lib/useLiveTicker.ts`) connects
straight from the browser to Kraken's public ticker websocket — no server, no API key. It hasn't
been exercised against the live socket in this environment; verify it manually with `pnpm web:dev`.

## Social metrics (started 2026-09-10)

Exploratory work, not part of the original plan: correlating price against social attention —
YouTube view/subscriber growth on curated Bittensor-related channels, and Google Trends search
interest for "Bittensor". **Kept as two separate metrics by design (user direction, 2026-09-10),
not folded into one composite** — meant to be optionally overlaid on the price charts rather than
merged into them. Google Trends has a working silver/gold series now (`social_trends_bittensor_weekly`,
in `gold.json`); YouTube is still bronze-only (see its subsection below).

### YouTube channel stats

Channel-level, not per-video: one `channels.list` call for every configured channel at once
(comma-joined `id`), 1 quota unit total regardless of channel count. The API has no historical-delta
endpoint for a channel you don't own, so daily view/sub *gains* will have to come from diffing
consecutive daily snapshots once silver exists — the same snapshot-and-diff shape used elsewhere in
this repo. This also means the series can only start from whenever snapshotting began; there's no
backfilling past days the way price OHLCV can be backfilled from an exchange's own history.

```
pnpm youtube:snapshot-channels    # 1 quota unit/day total; writes bronze/social/youtube_channel_stats/<date>.parquet
```

Requires `YOUTUBE_API_KEY` (free, no billing account needed — enable "YouTube Data API v3" in a
Google Cloud project, then Credentials -> Create Credentials -> API key). Curated channels live in
`packages/ingest/src/social/channels.ts` (handle + resolved channel ID + title, mirroring
`venues.ts`'s "config, not discovery" shape); re-resolve a handle with
`pnpm --filter @tao-tools/ingest run youtube:resolve-channels` if it's ever reassigned. Confirmed
working against real R2 2026-09-10 (5 channels, one row each).

**No silver/gold yet — still bronze-only.** When this gets built, the gold layer needs to export
one series *per channel* (view/sub deltas), not a single pre-summed total: the user wants the web
UI to let viewers pick which of the configured channels count toward the cumulative daily total
when this metric is enabled (2026-09-10 direction), which only works if gold ships per-channel
series for the frontend to sum over a user-chosen subset — summing server-side into one series now
would make that toggle impossible to add later without a registry version bump and a re-materialize.

### Google Trends search interest

No official API for this — `trendsClient.ts` reverse-engineers the same undocumented
`trends.google.com/api/*` endpoints `pytrends` wraps (cookie priming, then `explore` for a
one-time widget token, then `widgetdata/multiline` for the actual series). Confirmed working
manually 2026-09-10, including hitting and recovering from real 429s during development — this is
the flakiest data source in the repo and can start returning HTML error pages instead of JSON at
any time if Google changes the frontend.

Unlike YouTube's cumulative counters, Trends returns the *entire* requested range in one response
— for "Bittensor" since 2024-04-11 (matching price data's earliest venue history) that's 127 weekly
points in a single call, since Google auto-downsamples anything past ~9 months to weekly resolution
regardless of what's asked for (no daily history possible for a range this long). This means
"backfill" and "refresh" are the same script — re-running it later just re-derives the whole series
against a later end date. **The 0-100 scale is normalized to the peak within each fetch's own date
range**, so re-running can shift an old week's value slightly; each bronze row carries `fetched_at_ms`
so that's traceable rather than silently overwritten.

```
pnpm trends:backfill    # no API key needed; writes bronze/social/google_trends/<keyword-slug>/<fetch-date>.parquet
```

Keywords live in `packages/ingest/src/social/trendsKeywords.ts` — just `"Bittensor"` for now
(bare "TAO" was deliberately avoided, too ambiguous). Confirmed working against real R2 2026-09-10:
127 points, 2024-04-07 to the current (partial) week, values ranging 4-100.

**Silver/gold built 2026-09-10.** `materializeSilverGoogleTrends` (`packages/pipeline/src/silver/
materializeGoogleTrends.ts`) collapses bronze's per-fetch-date files down to each keyword's most
recently fetched series — picked by each row's own `fetched_at_ms`, not the file's date, since
that's what actually distinguishes two fetches of the same historical week under a different
0-100 normalization. Wired into `pnpm pipeline:materialize` as an optional step (skips cleanly, no
error, if `trends:backfill` hasn't been run yet — same "valid empty state" treatment as chain
silver in a Phase-1-only environment). Gold metric `social_trends_bittensor_weekly` (registry v1)
just filters to the one keyword and ships in `gold.json` — confirmed end-to-end 2026-09-10: 127
real points flowing through export.

Both sources now have a systemd-timer-driven continuous sync for an
always-on server (`sync-youtube.sh`/`sync-trends.sh`, once a day each — see
"Continuous bronze sync" below); locally, run `youtube:snapshot-channels`/
`trends:backfill` by hand as before. No chart renders either series yet
(the overlay-on-price-chart UI hasn't been built).

## Going from local to real infra

`BRONZE_URI` selects local (`./data/bronze`, the Phase 0/1 default) vs. real R2 (`s3://<bucket>`)
purely via `.env` — DuckDB `COPY` writes identically either way, no code change.

1. **R2** — done. `.env` has real `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
   and `BRONZE_URI=s3://tao-bronze`. One non-obvious catch if you're setting this up fresh:
   DuckDB's `TYPE R2` secret only auto-applies to `r2://`-scheme paths, not `s3://` — without an
   explicit `SCOPE 's3://'` on `CREATE SECRET` (see `packages/ingest/src/bronze/r2Secret.ts`),
   every `s3://` request silently goes out unauthenticated and R2 reports a confusing
   "bucket does not exist" instead of a permissions error. Also make sure the R2 API token is a
   real **R2 API token** (Access Key ID + Secret Access Key, created from inside the R2 section of
   the dashboard) — a general Cloudflare *account* API token, even one scoped to "Workers R2
   Storage", is a different credential system and won't authenticate against the S3-compatible
   endpoint at all.
2. **Blockmachine** — Pro plan is now active; `BLOCKMACHINE_API_KEY` is set and `pnpm spike-g` has
   been run — see plan §4.2 for the three gate answers. The full genesis backfill is done
   (2026-09-06, ~26.8M RPC calls at 3 per block). The monthly RU budget ran out once already
   (2026-09-05, implying ~1 RU/call — see above);
   check it before the next RPC-bound job, since everything still blocking Phase 3 —
   reconciliation, the genesis-baseline reads, and the hotkey→coldkey map wallet-count series 2
   needs — is RPC-bound.
3. **Vercel**: connect the repo, set the build to `pnpm --filter @tao-tools/web run build`,
   and wire the nightly job (plan §9) to push `data/export/gold.json` and hit the deploy hook.
   Not done yet.

## Continuous bronze sync (Hetzner / any always-on Ubuntu server)

Three independent sync scripts, one per bronze source, each with its own
systemd timer — deliberately separate rather than one combined job, so a
failure or rate-limit in one (Trends' unofficial API is the flakiest by far)
can never block the other two:

- [`sync-bronze.sh`](sync-bronze.sh) — chain. Incremental counterpart to the
  one-shot genesis backfill above: repeats `chain:backfill` with no
  `TO_BLOCK`, so every run resolves a fresh chain head and catches up from
  wherever the previous run's checkpoint left off. Runs every 15 minutes
  (`deploy/tao-sync.timer`) — chain activity is continuous, so this is the
  one source worth polling frequently.
- [`sync-youtube.sh`](sync-youtube.sh) — YouTube channel stats. One
  `channels.list` call (1 quota unit total) per run, writes today's
  cumulative view/sub/video counts. Stateless (no checkpoint — each run just
  overwrites today's bronze file), runs once a day
  (`deploy/tao-sync-youtube.timer`, 00:10 UTC) since the data has real daily
  granularity and more frequent polling buys nothing.
- [`sync-trends.sh`](sync-trends.sh) — Google Trends. Re-fetches the entire
  configured date range every run (this is correct, not wasteful — Trends
  has no "just the new points" endpoint and renormalizes its whole 0-100
  scale against the query's current end date regardless). Also stateless,
  also once a day (`deploy/tao-sync-trends.timer`, 00:30 UTC, offset from
  YouTube's run purely so they don't both hit the network at the same
  instant — no shared state, so this isn't a correctness requirement).

None of the three touch prices, decode anything, or produce chart data.
`chain:materialize-silver`/`pipeline:materialize`/`pipeline:export` (bronze
-> the tables the charts read) are a separate, unrelated step — run those
wherever/whenever you want fresh charts; they just read the same R2 bucket
these three keep topped up.

Because of that narrow scope, the server only needs `packages/core` +
`packages/ingest` — not `packages/pipeline` (ingest never depends on it,
only the reverse) and not `packages/web`. Code reaches the server via a git
sparse checkout (against a private GitHub remote — this repo doesn't have
one yet, push it once: `git remote add origin <url> && git push -u origin
master`); the only local-only state that isn't in git (secrets) goes over
via `deploy/push-state.sh`.

The chain backfill checkpoint is **not** part of that state transfer — once
`BRONZE_URI` points at R2, the checkpoint lives there too
(`chain/meta/backfill_checkpoint.json`, next to bronze itself; see
`packages/ingest/src/chain/r2Checkpoint.ts`), so any machine with a working
`.env` resumes from the same point on its own. Moving which machine runs the
sync — laptop to VPS, or back — is a `git pull`, not a file copy. (Local dev
against a local-path `BRONZE_URI` still uses a local checkpoint file, same
as before; there's nothing to share in that mode.)

One-time setup, on the server:

```
git clone --filter=blob:none --no-checkout <your-repo-url> /opt/tao-tools
cd /opt/tao-tools
git sparse-checkout init --cone
git sparse-checkout set packages/core packages/ingest deploy
git checkout master
```

Then, from this machine:

```
deploy/push-state.sh user@your-server:/opt/tao-tools
```

That pushes `.env` (gitignored, so it only exists here) — R2 credentials
and Blockmachine's API key are all the server needs; `chain:backfill` reads
its resume point straight from R2. **Never run `sync-bronze.sh` on two
machines at once against the same bucket** — the checkpoint has no
cross-machine locking, just last-write-wins (see `r2Checkpoint.ts`'s doc
comment for why that's an acceptable tradeoff here).

Back on the server, build and start all three timers:

```
cd /opt/tao-tools
pnpm install --filter @tao-tools/ingest... && pnpm --filter @tao-tools/ingest... run build
./sync-bronze.sh    # run each once by hand to confirm it works end to end
./sync-youtube.sh
./sync-trends.sh
sudo cp deploy/tao-sync.service deploy/tao-sync.timer \
        deploy/tao-sync-youtube.service deploy/tao-sync-youtube.timer \
        deploy/tao-sync-trends.service deploy/tao-sync-trends.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tao-sync.timer tao-sync-youtube.timer tao-sync-trends.timer
```

Future code changes to `packages/core`/`packages/ingest`: push from here as
usual (`git push`), then on the server run
[`deploy/update.sh`](deploy/update.sh) (`git pull` + rebuild, scoped to the
same two packages) — one rebuild covers all three sync scripts.

Follow logs live: `journalctl -u tao-sync -f` / `-u tao-sync-youtube -f` /
`-u tao-sync-trends -f`. Check schedule/last run: `systemctl list-timers` (no
argument lists all three) or `systemctl status <unit>`. `tao-sync.timer`'s
`OnUnitActiveSec=15min` is relative to the previous run *finishing*, so a
slow catch-up (e.g. after downtime) just delays the next run instead of
overlapping it; the YouTube/Trends timers use `OnCalendar` instead (once a
day, see their own files for why) since that data doesn't need — or benefit
from — polling every 15 minutes. All three scripts take their own `flock` in
case one is ever invoked manually while its timer's run is still going.

## Repo layout

See plan §3. `packages/core` has zero I/O (enforced by a test — see
`packages/core/test/purity.test.ts`); `ingest` and `pipeline` depend on it, never the reverse.

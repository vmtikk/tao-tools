# tao-tools

TAO analytics pipeline. See [tao-analytics-plan.md](tao-analytics-plan.md) for the full spec.

**Status: Phase 1 (prices and volume — charts 1–3) implemented; Phase 2.1/2.2 (chain tracer
bullet + balance reconciliation) implemented, bronze now writes to real Cloudflare R2. Phase 2.3's
backfill is complete — the full genesis-to-head event index (blocks 1–8,929,643) landed in bronze
2026-09-06, was decoded to silver 2026-09-08, and gold/export were rebuilt across the whole range
2026-09-09.** Every venue is fetched through `ccxt` (§2 stack), including Kraken — the Phase 0
hand-rolled Kraken REST client was migrated in Phase 1. Blockmachine Pro is active.

**Phase 3's numbers are still provisional, and this is the one thing blocking the project.**
`chain:reconcile-checkpoints` has never completed against real chain data — only against fixtures
— so nothing in the fold has been checked against on-chain ground truth. There is now concrete
evidence it needs to: on the full index, `account_balances_daily` has **116,930 rows with a
negative balance across 10,620 distinct coldkeys** (~2% of all 505,493), and
`exchange_balances_daily` still bottoms out at **−9,154.6 TAO**. A negative on-chain balance is
impossible; these are the genesis-funded accounts of plan §10 (funded directly in genesis state,
so no `Deposit` event ever fires and the fold starts them at zero). Fixing it needs real
`System.Account` reads — i.e. the same RPC work reconciliation needs. Don't treat wallet counts or
exchange balances as final until that run comes back clean. RU cost also still needs a
Blockmachine-dashboard check (§4.2) — the backfill alone spent 569,181 RPC calls on top of the
~192,000 spent sampling, and reconciliation across 505,493 coldkeys has never been sized.

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

`ingest:backfill-prices` is a real, potentially long-running pull against seven exchanges — it
has not been run against live APIs yet (only unit/contract-tested against fixtures and injected
fetchers). Run it manually when ready; it's resumable in the sense that re-running it just
re-fetches and dedupes in silver, so a partial/interrupted run is not destructive. **This is why
the price charts are near-empty** while the chain charts span the full history: the current
`gold.json` carries 587 points for `price_composite_usd` and none at all for `price_composite_btc`,
because silver only holds whatever thin OHLCV has been pulled so far. Unrelated to any of the chain
work — it's a Phase 1 gap.

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

**Done 2026-09-06: blocks 1–8,929,643 are in bronze**, 569,181 RPC calls in total, run across
several sessions off the checkpoint below. Decoded to silver 2026-09-08 — 102,358,339 transfers
(after removing the 1,447 duplicates described below), 235,553,651 balance events, 3,306,536 stake
events. Two blocks failed to decode and were skipped
(logged to `data/meta/materialize_silver_skipped_blocks.jsonl`); that path is deliberate, see
`materializeChainSilver`'s catch — a single block's SCALE bytes failing to decode must not halt
the other 8.9M.

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
dashboard (~192,000 RPC calls sampling, plus the backfill's own 569,181) to confirm the ~13.5–27M
RU projection fits Pro's 20M/month quota — see plan §4.2 and §6. The monthly budget ran out once
already, on 2026-09-05, which is what blocked reconciliation then.

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

### Phase 2.3 — reconciliation checkpoints

```
pnpm chain:reconcile-checkpoints    # incremental reconciliation, genesis -> UP_TO_BLOCK
```

Required env: `UP_TO_BLOCK` — the block `chain:materialize-silver` has actually decoded up to
(check `data/meta/chain_backfill_checkpoint.json`'s `lastCompletedBlock`, then confirm silver was
re-materialized against that bronze), **not** the live chain head. Optional: `FROM_BLOCK` (default
1), `CHECKPOINT_INTERVAL_BLOCKS` (default 216,000, ≈30 days at 12s/block).

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
coldkeys, and has never been sized at that scale. Estimate the reads before spending budget.

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
   (2026-09-06, 569,181 RPC calls). The monthly RU budget has run out once already (2026-09-05);
   check it before the next RPC-bound job, since everything still blocking Phase 3 —
   reconciliation, the genesis-baseline reads, and the hotkey→coldkey map wallet-count series 2
   needs — is RPC-bound.
3. **Vercel**: connect the repo, set the build to `pnpm --filter @tao-tools/web run build`,
   and wire the nightly job (plan §9) to push `data/export/gold.json` and hit the deploy hook.
   Not done yet.

## Continuous bronze sync (Hetzner / any always-on Ubuntu server)

[`sync-bronze.sh`](sync-bronze.sh) is the incremental counterpart to the
one-shot genesis backfill above, and *only* that — it repeats `chain:backfill`
with no `TO_BLOCK`, so every run resolves a fresh chain head and catches up
from wherever the previous run's checkpoint left off. Nothing else: it
doesn't touch prices, doesn't decode anything, doesn't produce chart data.
`chain:materialize-silver`/`pipeline:materialize`/`pipeline:export` (bronze
-> the tables the charts read) are a separate, unrelated step — run those
wherever/whenever you want fresh charts; they just read the same R2 bucket
this keeps topped up.

Because of that narrow scope, the server only needs `packages/core` +
`packages/ingest` — not `packages/pipeline` (ingest never depends on it,
only the reverse) and not `packages/web`. Code reaches the server via a git
sparse checkout (against a private GitHub remote — this repo doesn't have
one yet, push it once: `git remote add origin <url> && git push -u origin
master`); the small amount of local-only state that isn't in git (secrets,
the backfill checkpoint) goes over via `deploy/push-state.sh`.

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

That pushes `.env` and `data/meta/chain_backfill_checkpoint.json`
(gitignored, so they only exist here) — without the checkpoint the server
would start `chain:backfill` over from block 1 instead of resuming. **Never
run `sync-bronze.sh` on the server at the same time as a manual
`chain:backfill` here** — both read/write that same checkpoint file.

Back on the server, build and start the timer:

```
cd /opt/tao-tools
pnpm install --filter @tao-tools/ingest... && pnpm --filter @tao-tools/ingest... run build
./sync-bronze.sh   # run once by hand to confirm it works end to end
sudo cp deploy/tao-sync.service deploy/tao-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tao-sync.timer
```

Future code changes to `packages/core`/`packages/ingest`: push from here as
usual (`git push`), then on the server run
[`deploy/update.sh`](deploy/update.sh) (`git pull` + rebuild, scoped to the
same two packages).

Follow logs live: `journalctl -u tao-sync -f`. Check schedule/last run:
`systemctl list-timers tao-sync.timer` / `systemctl status tao-sync.service`.
`OnUnitActiveSec=15min` in the timer is relative to the previous run
*finishing*, so a slow catch-up (e.g. after downtime) just delays the next
run instead of overlapping it; `sync-bronze.sh` also takes its own `flock` in
case it's ever invoked manually while the timer's run is still going.

## Repo layout

See plan §3. `packages/core` has zero I/O (enforced by a test — see
`packages/core/test/purity.test.ts`); `ingest` and `pipeline` depend on it, never the reverse.

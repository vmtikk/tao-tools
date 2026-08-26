# tao-tools

TAO analytics pipeline. See [tao-analytics-plan.md](tao-analytics-plan.md) for the full spec.

**Status: Phase 1 (prices and volume — charts 1–3) implemented; Phase 2.1/2.2 (chain tracer
bullet + balance reconciliation) implemented, bronze now writes to real Cloudflare R2.** Every
venue is fetched through `ccxt` (§2 stack), including Kraken — the Phase 0 hand-rolled Kraken REST
client was migrated in Phase 1. Phase 2.3 (the full genesis backfill) is explicitly not started —
it needs the Blockmachine Pro plan, which isn't active yet (§4.2, §6).

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
re-fetches and dedupes in silver, so a partial/interrupted run is not destructive.

`pnpm test` runs the full suite (unit, query, contract, golden-file — see plan §5).

### Phase 2.1/2.2 — chain tracer bullet

```
pnpm chain:ingest                    # blocks 1-1000 (default): raw System.Events + Timestamp.Now -> R2 bronze
pnpm chain:materialize-silver        # bronze chain/* -> silver/transfers.parquet + balance_events.parquet
pnpm pipeline:materialize            # (as above) now also produces gold/transfer_count_per_block.parquet
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
  moved from those). `transfer_count_per_block` is a near-empty series (2 points) — correct, not a
  bug; this window mostly proves the decode path, not real transfer volume.
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
2. **Blockmachine** — done for Phase 2.1/2.2. `BLOCKMACHINE_API_KEY` is set (free tier) and
   `pnpm spike-g` has been run — see plan §4.2 for the three gate answers. Phase 2.3 (the full
   genesis backfill, ~8.9M blocks) still needs the Pro plan; not upgraded yet, and per plan §6
   this doesn't start until Phase 1's price composite is separately validated.
3. **Vercel**: connect the repo, set the build to `pnpm --filter @tao-tools/web run build`,
   and wire the nightly job (plan §9) to push `data/export/gold.json` and hit the deploy hook.
   Not done yet.

## Repo layout

See plan §3. `packages/core` has zero I/O (enforced by a test — see
`packages/core/test/purity.test.ts`); `ingest` and `pipeline` depend on it, never the reverse.

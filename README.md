# tao-tools

TAO analytics pipeline. See [tao-analytics-plan.md](tao-analytics-plan.md) for the full spec.

**Status: Phase 1 (prices and volume — charts 1–3) implemented, running against a local
stand-in for bronze.** R2, Blockmachine, and the Vercel deploy hook are not wired up yet — see
"Going from local to real infra" below. Every venue is fetched through `ccxt` (§2 stack),
including Kraken — the Phase 0 hand-rolled Kraken REST client was migrated in Phase 1.

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

Nothing above required credentials — `BRONZE_URI` defaulted to `./data/bronze`, a local
stand-in that DuckDB COPY writes to identically to how it writes to R2. To point at the real
thing:

1. **R2**: fill in `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` and set
   `BRONZE_URI=s3://tao-bronze` in `.env`. No code changes.
2. **Blockmachine** (Phase 2+, and Spike G — plan §4.2): set `BLOCKMACHINE_API_KEY`, then run
   `pnpm spike-g`. This has not been run yet — the plan's three gate questions are unanswered
   pending an API key.
3. **Vercel**: connect the repo, set the build to `pnpm --filter @tao-tools/web run build`,
   and wire the nightly job (plan §9) to push `data/export/gold.json` and hit the deploy hook.
   Not done yet.

## Repo layout

See plan §3. `packages/core` has zero I/O (enforced by a test — see
`packages/core/test/purity.test.ts`); `ingest` and `pipeline` depend on it, never the reverse.

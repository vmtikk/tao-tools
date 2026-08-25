# tao-tools

TAO analytics pipeline. See [tao-analytics-plan.md](tao-analytics-plan.md) for the full spec.

**Status: Phase 0 (walking skeleton) implemented, running against a local stand-in for bronze.**
R2, Blockmachine, and the Vercel deploy hook are not wired up yet — see "Going from local to
real infra" below.

## Setup

```
pnpm install
cp .env.example .env
```

Node 22 is what the plan specifies; this was built and tested on Node 20, which also works —
upgrade when convenient, nothing here depends on a 22-only feature.

## Running Phase 0 end to end

```
pnpm ingest:kraken          # fetch last 24h Kraken TAO/USD -> data/bronze/prices/kraken/TAOUSD/*.parquet
pnpm pipeline:materialize   # bronze -> data/silver/ohlcv_1m.parquet -> data/gold/price_composite_1m.parquet
pnpm pipeline:export        # gold -> data/export/gold.json
pnpm web:dev                # http://localhost:3000 — renders the chart from data/export/gold.json
```

`pnpm test` runs the full suite (unit, query, contract, golden-file — see plan §5).

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

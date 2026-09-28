# TAO Analytics — v1 Pipeline

**Status:** Spec / not yet built
**Scope:** Personal use, single user. No hosting costs, no public API, no redistribution.
**Goal of v1:** Prove the pipeline works end to end on a small surface area. Subnet/alpha data is
deliberately excluded — it is the v2 scale-up, and the whole point of v1 is to validate the shape
before taking that on.

**Method:** TypeScript throughout, built in vertical slices. Every phase ends with a chart rendering
in a browser from real data that travelled the full bronze → silver → gold → export → web path. No
phase builds a layer that nothing above it consumes yet.

---

## 1. What v1 delivers

Five charts, all derived from TAO-level data, in the order they light up:

| # | Chart | Lights up | Depends on chain? |
|---|---|---|---|
| 1 | **TAO/USD price history** — 1m resolution, to listing date | Phase 0 (thin) → Phase 1 (full) | No |
| 2 | **TAO/BTC price history** | Phase 1 | No |
| 3 | **TAO trading volume in USD** — aggregated across venues | Phase 1 | No |
| 4 | **Wallet count over time** — three definitions, see §7.1 | Phase 3 | Yes |
| 5 | **Percent of supply in profit** — estimated cost basis, §7.3 | Phase 4 | Yes |

Plus **TAO on exchanges** (§7.2) if the label-building work lands in time — it's independent of
everything else and can slip without blocking.

Charts 1–3 need no chain access and no paid plan. That is deliberate: three of five charts ship
before a dollar is spent, and they are the price series that chart 5 later depends on being correct.

**Out of scope for v1:** subnet/alpha analytics, validator yields, APY, emissions breakdowns,
social/off-chain data, anything requiring per-block resolution.

---

## 2. Architecture

```
Blockmachine RPC ─┐
                  ├─→ ingestion workers (local Docker) ─→ BRONZE: Cloudflare R2
Exchange APIs ────┘                                              │
                                                                 │ S3 range reads
                                                                 ↓
                                              DuckDB (local) ─→ SILVER ─→ GOLD
                                                                            │
                                                                            ↓
                                                          Vercel static site (nightly)
```

### The layering rule

**Bronze is immutable and never re-fetched.** Every raw API/RPC response is written to Parquet
before parsing. All derived metrics compute *from bronze*, never by re-hitting the network. When a
schema decision turns out wrong in month four, that's a local recompute, not another backfill.

Bronze lives on R2 rather than local disk because it's cold — written once, read only on rebuilds.
Silver and gold are hot (every query touches them) and stay local.

### Stack

- **TypeScript / Node 22** — one language across ingestion, transformation, and the web app. Shared
  domain types mean the definition of a coldkey balance is the same object in the worker, the
  registry, and the chart.
- **pnpm workspaces** — monorepo, see §3.
- **Docker** — one container for ingestion workers, one local volume for silver/gold
- **DuckDB** via `@duckdb/node-api` — analytics engine. Reads bronze from R2 in place via the
  `httpfs` extension; reads silver/gold from local disk. No Postgres, no Timescale, no server process.
- **Cloudflare R2** — bronze object store. S3-compatible, so DuckDB issues HTTP range requests and
  fetches only the Parquet column chunks a query needs. Zero egress.
- **Parquet + zstd** — every layer
- **`@polkadot/api`** — Substrate JSON-RPC and SCALE decoding, with a custom provider carrying the
  Blockmachine bearer token
- **`ccxt`** — exchange REST/websocket, TypeScript-native
- **Vitest** — unit and DuckDB-backed integration tests
- **Next.js on Vercel** — static site, §10

### DuckDB is the only Parquet writer

Do not add a JavaScript Parquet library. Every Parquet file in every layer — including bronze — is
written by DuckDB:

```sql
COPY (SELECT * FROM staged) TO 's3://tao-bronze/prices/kraken/TAOUSD/2026-08.parquet'
  (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 1000000);
```

One writer means one set of type mappings, one compression setting, one row-group policy, and no
chance of the Node writer and the DuckDB reader disagreeing about how a `bigint` or a timestamp
round-trips. The Node process stages rows into a DuckDB table and issues `COPY`; it never encodes
Parquet itself. DuckDB writes to R2 directly through `httpfs`, so there is no local temp file to
clean up.

### Layout

```
R2 bucket: tao-bronze/
  chain/events/{block_range}.parquet          # raw System.Events + Timestamp.Now blobs, unparsed hex, per block
  chain/metadata/{spec_version}.parquet       # runtime metadata, one row per upgrade
  prices/{exchange}/{pair}/{yyyy-mm}.parquet  # raw klines
  chain/checkpoints/{date}.parquet            # monthly reconciliation snapshots

local /data
  /silver
    transfers.parquet
    stake_events.parquet
    ohlcv_1m.parquet
    account_balances_daily.parquet
  /gold
    price_composite_1m.parquet
    volume_usd_daily.parquet
    wallet_counts_daily.parquet
    exchange_balances_daily.parquet
    supply_in_profit_daily.parquet
  /meta
    metrics_registry.yaml          # see §8
    exchange_labels.json
    runtime_versions.parquet
    ingestion_log.parquet
  /export
    gold.json                      # what ships to Vercel
```

### Sizing expectation

Bronze ~20–50 GB, silver a few GB, gold under 1 MB. If bronze trends well above 50 GB in v1,
something is being over-captured — investigate before scaling storage.

**Parquet file sizing matters on R2.** Write reasonably large files (roughly 100–500 MB) rather
than many small objects. Millions of tiny objects burn Class A operations on write and make range
reads inefficient.

---

## 3. Repo layout and the dependency rule

```
tao-tools/
  packages/
    core/          # pure domain. Types, reducers, composites, validators. ZERO I/O.
    ingest/        # exchange clients, RPC client, bronze writers
    pipeline/      # DuckDB sessions, silver/gold materialization, registry runner
    web/           # Next.js app
  fixtures/        # recorded API responses, sample blocks, golden gold.json snapshots
  docker/
```

**The dependency rule, enforced in CI:** `core` may not import `node:fs`, `node:http`, `ccxt`,
`@polkadot/api`, `@duckdb/node-api`, or anything that touches a socket or a disk. `ingest` and
`pipeline` depend on `core`; `core` depends on nothing but itself.

This rule is what makes red-green-refactor possible on a data pipeline. Everything that can be
*wrong* — the composite weighting, the balance fold, the cost-basis reducer, the dust filter — lives
in `core` as a pure function over plain data and is testable in milliseconds without a network, a
database, or a fixture directory. Everything in `ingest` and `pipeline` is plumbing: fetch bytes,
hand them to `core`, write the result. Plumbing gets contract tests against recorded fixtures; it
does not get clever.

### Type rules

TypeScript earns its place here by making two specific classes of bug unrepresentable.

**1. Coldkeys are not hotkeys.** §7.1 flags this as critical, and it cannot be enforced by
convention because both are SS58 addresses with identical form — nothing at runtime distinguishes
them. So distinguish them at compile time:

```ts
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type Coldkey = Brand<string, 'Coldkey'>;
export type Hotkey  = Brand<string, 'Hotkey'>;
```

`Coldkey` and `Hotkey` are mutually unassignable. A function that counts wallets takes
`Set<Coldkey>` and will not compile if handed hotkeys. Construction goes through
`asColdkey(s: string)` / `asHotkey(s: string)`, which are the only casts in the codebase and live in
one audited file.

**There is no `Address` type and no `address` column.** Every schema, every DuckDB column, every
struct field is named `coldkey` or `hotkey`. A test asserts no silver or gold table exposes a column
named `address`.

**2. On-chain amounts are `bigint`, never `number`.** TAO is denominated in rao, 1 TAO = 10⁹ rao,
stored on chain as `u64`. A `u64` in rao exceeds `Number.MAX_SAFE_INTEGER` at ~9.007M TAO — inside
the range of real exchange balances, not a theoretical edge. Floats also make the cost-basis
accumulator in §7.3 silently non-reproducible.

```ts
export type Rao = Brand<bigint, 'Rao'>;   // integer, chain-native
export type Tao = Brand<number, 'Tao'>;   // decimal, DISPLAY ONLY
```

Conversion `Rao → Tao` happens at exactly one place: the gold export boundary. DuckDB `BIGINT`
round-trips to JS `bigint` through `@duckdb/node-api`, so the type survives the whole pipeline. Cost
basis is accumulated as an integer ratio, not a float.

Also branded: `BlockNumber`, `UnixMillis`, `SpecVersion`, `UsdCents`. Each is a place someone has
previously passed seconds where milliseconds were expected.

---

## 4. Data sources

### 4.1 Prices and volume — free, no account

Exchange REST kline endpoints, backfilled to listing date, then websocket for live.

| Pair | Venues |
|---|---|
| TAO/USD | Kraken, Coinbase |
| TAO/BTC | Kraken, Upbit |
| TAO/USDT | Binance, Bybit, OKX, MEXC, Gate |

- Resolution **1m**. Aggregate up locally; never store only aggregates.
- Store per-venue OHLCV **plus quote volume** — quote volume is what the USD volume chart needs.
- Build a **volume-weighted composite** for TAO/USD and TAO/BTC. Do not trust a single venue.
- **Automated sanity check:** composite TAO/USD ÷ BTC/USD should track composite TAO/BTC.
  Persistent divergence means a venue is stale or mislabeled. This runs as a test, not a dashboard
  glance — see §6.

`ccxt` normalizes most venue quirks, but not all: pagination direction, max candles per request,
whether the final candle is partial, and whether volume is base or quote all vary. Each venue gets
a thin adapter in `ingest` and a contract test against a recorded response (§6).

**Volume caveat to surface in the chart itself:** you only count venues you poll. The series will
undercount versus aggregators, especially in early history. Label it.

**Findings (2026-09-10, a real backfill run): the TAO/BTC venue table above doesn't hold up.**
Neither Kraken nor Upbit actually has a real TAO/BTC market — Kraken's ccxt market list has no
`TAO/BTC` symbol at all, and Upbit returns zero candles even for a recent `since` with no error.
`BTC_VENUES` (`packages/ingest/src/exchanges/venues.ts`) is empty and expected to stay that way —
no reputable exchange appears to list this pair. Bybit and Gate.io were also dropped from the
TAO/USDT list the same day: Bybit has no `TAO/USDT` market under ccxt either, and Gate.io hard-caps
history at ~7 days via its own API (`"Candlestick too long ago. Maximum 10000 points ago are
allowed"`), so it can't contribute to a 2023-onward backfill at all. Kraken itself turned out to
only serve a live-tail window for 1-minute candles regardless of `since` (no error, just today's
data) — real for current pricing, useless for backfill.

**Consequently, `price_composite_btc` is now an implied cross-rate, not a direct composite** —
`price_composite_usd ÷ reference_btc_usd` (registry v2), constructed from the two real USD-quoted
composites rather than a nonexistent direct pair. This retires the "automated sanity check" above
in its original form: it compared an independently-sourced TAO/BTC price against the implied ratio
to catch a stale/mislabeled venue, and now those two values are the same thing by construction, so
the check can never diverge again. See the README's "Chart 2 redefined as an implied cross-rate"
section for the full account, including what `reference_btc_usd` itself needed (Binance's
`BTC/USDT`, since Kraken's `BTC/USD` has the identical live-tail-only limitation).

### 4.2 Chain access — Blockmachine

- Endpoints: `https://rpc.blockmachine.io` (HTTP), `wss://rpc.blockmachine.io` (WS)
- Auth: `Authorization: Bearer <API_KEY>` — passed via the `headers` option on the `@polkadot/api`
  `HttpProvider` / `WsProvider`
- **Substrate JSON-RPC, not EVM.** `state_getStorage`, `state_getKeysPaged`, `chain_getBlockHash`,
  `state_getMetadata`.

Per block, the event capture is **three** calls, not two as originally scoped here:
`chain_getBlockHash(n)`, `state_getStorage` at the constant `System.Events` key
(`twox128("System") ++ twox128("Events")`), and `state_getStorage` at `Timestamp.Now`
(`twox128("Timestamp") ++ twox128("Now")`). The third call was added during Phase 2.1/2.2 — every
downstream metric (§7.1 daily wallet counts, §7.3 "mark each inflow at the composite price at that
block's timestamp") needs a real per-block timestamp, and capturing it during the one pass over
each block is cheap next to *not* capturing it and needing a second full backfill later just to add
it (§10: "Filtered event capture blocks v2" is the same argument applied to a second field, not a
second pallet). **This changes the RU sizing below by ~50%** — see the note under "Plans." Every
response is stored as raw hex. **No decoding happens during ingestion** — that is what makes bronze
re-parseable.

**GATE — Spike G, do this before writing any chain code (§6, Phase 0):**

1. **Verify archive depth reaches TAO genesis (2023).** Blockmachine documents that archive
   availability and depth vary by network. Test a `state_getStorage` at an early 2023 block hash.
   If depth is insufficient, the cost-basis metric loses its foundation — stop and raise it.
2. **Verify metadata version at genesis-era blocks is v14 or later.** v14+ metadata is
   self-describing, so `@polkadot/api` decodes subtensor's custom events with no hand-written type
   definitions. If early blocks are pre-v14, decoding those ranges needs bespoke type registries and
   the effort estimate for Phase 2 changes materially.
3. **Measure actual RU consumption.** Published RU weights are for EVM methods (`eth_call` = 1,
   `eth_getLogs` = 5). Substrate method weights are unpublished, and `state_getKeysPaged` may be
   weighted heavier than a plain storage read. Index ~1,000 blocks on the free tier and read the
   dashboard. This settles the plan sizing in an hour instead of by estimate.

**Findings (run 2026-08-26, free tier, `pnpm spike-g` plus ad hoc probing against
`https://rpc.blockmachine.io`):**
1. **PASS.** `chain_getBlockHash(1)` and `state_getStorage` at that hash both succeed — archive
   reaches genesis (block 1, 2023-03-20).
2. **PASS.** Metadata at block 1 is V14 (self-describing).
3. **Measured, but in a different unit than the Standard/Pro RU quotas above.** The free tier
   throttles by `cu_per_minute`, not a monthly RU budget: 50 compute-units/minute, and
   `chain_getBlockHash` / `state_getStorage` / `state_getMetadata` / `state_getRuntimeVersion` each
   cost 1 CU (measured empirically — the API doesn't publish per-method weights, and a 429 response
   carries `{limit, remaining, reset, retry_after_ms}` so a client can pace itself exactly rather
   than guess). This says nothing directly about Pro/Standard's RU-per-request pricing for the full
   backfill (2.3) — that still needs its own measurement once Pro is active — but it fully sized
   Phase 2.1/2.2: 1,000 blocks x 3 calls/block (hash + events + timestamp) = ~3,000 CU, paced to
   ~40/min to stay under the cap, ran in **~75 minutes** end to end with zero cost.

**Plans:**
- Backfill: **Pro, $25/mo** — 20M RU, 12,000 req/min. The event index is ~9–18M RU, so Pro's
  included quota covers it with no overage. On Standard the same pull costs $9 + ~$65 in overage
  *and* takes ~12.5 days at 1,000 req/min instead of ~25 hours. Pro is both cheaper and faster for
  this month.
  **This 9–18M RU figure predates the third call above and needs re-checking before 2.3 starts.**
  It was sized against a 2-calls/block design; the real implementation is 3 calls/block (+50%),
  which projects to roughly **13.5–27M RU** — the top of that range would overshoot Pro's 20M
  quota. The free-tier findings above measured *pacing* (CU/min), not Pro's *per-request RU price*,
  so this can't be resolved by arithmetic alone: re-run something like Spike G's step 3 — index a
  few thousand blocks with the real 3-call ingest script (`pnpm chain:ingest`) once Pro is active,
  read the actual RU delta off the dashboard, and recompute the full 8.9M-block estimate from a
  measured per-block cost before committing to the backfill. If it lands above 20M, either accept
  Standard-tier overage for that month or drop the timestamp call and backfill it separately later
  (against the "no second backfill" argument above, but possibly still cheaper than the overage).

  **Measured on Pro, after the fact (2026-09-09) — the pre-flight measurement above never happened;
  the backfill was run without it, and the warning turned out to be right.** Call volume is exact:
  the final backfill session did 569,181 calls over blocks 8,740,001–8,929,643, i.e. **3.0
  calls/block**, so the full range cost **~26.8M calls**. (Do not read a total off `backfill.log` —
  the script's counter resets on every process start, so its closing line is one session, not the
  run.) RU-per-call was never read off the dashboard, but the budget exhaustion dates it: the quota
  ran out on 2026-09-05 at block 6,440,000, i.e. ~19.3M backfill calls plus the ~192,000 spent
  sampling ≈ **19.5M calls against Pro's 20M RU quota — so ≈1 RU per call**. That puts the full
  backfill at **~26.8M RU**, over Pro's monthly quota, exactly the overshoot flagged above when the
  design went from 2 to 3 calls per block. It is why the run spanned more than one budget period.
  Steady state is unaffected and needs no re-measuring: 7,200 blocks/day × 3 ≈ **650K RU/month**,
  consistent with the ~645K projected below. Still worth confirming ≈1 RU/call against the actual
  dashboard before sizing reconciliation, since that conversion is now load-bearing for the only
  remaining budget decision (§6, closeout item 3).
- Steady state: **Standard, $9/mo** — head-of-chain indexing is ~430k RU/month, 10x headroom. Also
  based on the 2-call design; head-of-chain indexing is one block at a time regardless, so the +50%
  here is small in absolute terms (~645k RU/month) and Standard's headroom easily absorbs it — this
  one doesn't need re-measuring before going ahead.

Build **retry-with-backoff** from the start. Requests over the per-minute limit are rejected
outright, not queued. Failed requests are not billed.

### 4.3 Bronze storage — Cloudflare R2

- Standard storage $0.015/GB-month; Class A ops (writes, lists) $4.50/million; Class B ops (reads)
  $0.36/million; egress free at any volume.
- Free tier: 10 GB storage, 1M Class A, 10M Class B per month.
- At 50 GB: (50 − 10) × $0.015 = **~$0.60/month**.

**DuckDB reads and writes bronze in place.** Install `httpfs`, `CREATE SECRET` against the R2
endpoint (`<account>.r2.cloudflarestorage.com`, `region 'auto'`, path-style URLs), query
`s3://tao-bronze/...` directly. Do not mount R2 as a filesystem (rclone mount, SSHFS, WebDAV) —
Parquet scans generate many small seeks and filesystem-over-network turns each into a round trip.
Either native `httpfs` range reads or an explicit local sync. Never the middle.

---

## 5. Testing strategy

Red-green-refactor, applied to a pipeline. The discipline only works if there is something fast and
deterministic to write a failing test *against*, which is what the §3 dependency rule buys.

### The three test tiers

| Tier | Runs against | Speed | Covers |
|---|---|---|---|
| **Unit** | `core`, in-memory, no I/O | <1s whole suite | Every reducer, composite, filter, validator |
| **Query** | DuckDB in-memory + fixture Parquet | seconds | Every SQL statement in the metric registry |
| **Contract** | Recorded HTTP/RPC fixtures | seconds | Per-venue adapters, RPC client, retry/backoff |

Live network and real R2 are exercised by **smoke checks**, run on demand and nightly. They are not
part of `pnpm test` and never gate a commit — a Kraken outage must not turn the suite red.

### Tier 1 — unit, and what belongs in it

Everything that can produce a wrong number:

- **Kline normalization** — per venue, array shape → `Ohlcv`; base vs quote volume; partial final candle
- **Volume-weighted composite** — including the degenerate cases: one venue, zero volume across all
  venues, one venue stale (last update > N minutes → excluded, not silently weighted)
- **Cross-rate divergence check** — given three series, does it flag a planted 5% drift
- **Event → row normalization** — decoded `EventRecord` → `Transfer` / `StakeEvent`
- **Balance reconstruction fold** — `(BalanceMap, Event[]) => BalanceMap`. A pure reducer, and the
  single highest-value test target in the project. Property test it: total supply is conserved
  across any permutation of transfers.
- **Cost-basis reducer** — §7.3, parameterized by emission rule, tested under both
- **Dust filter and coldkey classification** — §7.1
- **Gap detection** — given a block-height/timestamp sequence with a hole, is the hole reported
- **Registry DAG** — dependency ordering, cycle detection, unknown-dependency error

### Tier 2 — query tests

Registry SQL is where silent wrongness lives; it is code and it gets tested like code. Each metric
test spins an in-memory DuckDB, loads a small hand-authored fixture Parquet, runs the registry entry
verbatim, and asserts the output rows. Fixtures are deliberately tiny (tens of rows) and hand-built
to contain the edge case — a dust balance exactly at the threshold, a coldkey that goes to zero and
returns, a day with no events.

### Tier 3 — contract tests

Recorded real responses in `fixtures/`, replayed. Refresh them deliberately, never automatically —
a fixture that silently re-records defeats the point. Two things they must cover beyond happy path:

- **Rate-limit rejection** — Blockmachine errors immediately rather than queueing. The client's
  backoff must be tested against a fixture that returns 429, not assumed.
- **Truncated/partial responses** — the ingestion worker must fail loudly, never write partial bronze.

### Golden files, and how they enforce §8

`gold.json` is snapshot-tested against a committed golden file built from fixture inputs.

This is the enforcement mechanism for the metric registry's versioning rule: **changing a metric
definition breaks the snapshot.** The only way to make the suite green again is to update the golden
file, and the code review question at that moment is "did you bump the metric version?" Versioning
stops being a convention someone remembers and becomes a step you cannot skip.

### The loop, concretely

Taking `wallet_count_dust_filtered` as the example:

1. **Red** — write `dustFilteredCount` test in `core`: a balance map with entries at 0, 0.005, 0.01,
   and 0.02 TAO plus one hotkey, asserting a count of 1. It fails to compile (function doesn't
   exist). That counts as red.
2. **Green** — write the smallest thing that passes. Threshold comparison, hotkey exclusion.
3. **Red** — add the boundary case: is exactly 0.01 in or out? Decide, document the decision in the
   registry `definition` string, write the test to match.
4. **Green** — adjust.
5. **Refactor** — extract the threshold to the registry entry so it's data, not a literal.
6. Only now write the registry SQL and its Tier-2 test, then wire it to a chart.

The rule that keeps this honest: **no ingestion work starts before the transformation it feeds is
tested against fixtures.** Fetching 8.9M blocks to discover the decoder drops stake events is the
expensive version of a test that costs nothing.

---

## 6. Build phases — vertical slices

Each phase ends with something rendering in a browser. Nothing is built that the layer above it
doesn't consume in the same phase.

### Phase 0 — Walking skeleton

**The tracer bullet: one venue, one pair, one day, one chart, all the way through.**

Kraken TAO/USD, the most recent 24 hours, 1,440 one-minute candles. That's it. The point is not the
data; the point is that R2 credentials, DuckDB `httpfs`, the Parquet writer, the silver/gold
materialization, the registry runner, the JSON export, the Vercel deploy hook, and the chart
component all work together *before* anything is built at scale.

- `ingest`: Kraken adapter → stage → `COPY` to `s3://tao-bronze/prices/kraken/TAOUSD/{yyyy-mm}.parquet`
- `pipeline`: bronze → `silver/ohlcv_1m.parquet` → `gold/price_composite_1m.parquet`
- registry: one entry, `price_composite_usd`, version 1
- export `gold.json`, deploy, render a line chart

**Composite-of-one is the real composite function called with n=1** — not a passthrough shortcut.
Phase 1 widens the input array and changes no logic.

Tests written first: Kraken kline normalization (unit), composite with one venue (unit),
`price_composite_usd` SQL against a 10-row fixture (query), `gold.json` golden file.

**Also in Phase 0, in parallel: Spike G** (§4.2). One to two hours, free tier, no code shipped —
just answers written into this document. It gates Phase 2, not Phase 0 or 1, so it must not block
the skeleton. If archive depth fails, charts 4 and 5 are in question and it's better to know in
week one than month three.

**Done when:** a Vercel URL shows yesterday's TAO/USD from data that went through R2, and
`pnpm test` is green, and §4.2's three gate questions have written answers.

### Phase 1 — Prices and volume (charts 1, 2, 3)

Widening, no new architecture.

| Slice | Delivers |
|---|---|
| 1.1 | Remaining venue adapters, one contract test each. Composite now real. |
| 1.2 | Full backfill to listing date + gap detection into `ingestion_log.parquet` |
| 1.3 | TAO/BTC composite + the cross-rate sanity check as a scheduled assertion |
| 1.4 | USD volume metric and chart, with the undercount caveat rendered in the chart |
| 1.5 | Live websocket edge — rightmost pixel only (§10) |

**Done when:** charts 1–3 are live on full history and the cross-rate check runs green nightly.
Zero dollars spent to this point.

### Phase 2 — Chain tracer bullet, then the big pull

| Slice | Delivers |
|---|---|
| 2.1 | **1,000 blocks, end to end.** Fetch raw events → bronze → decode at silver → transfers → a transfer-count-per-block chart. Cheap, free tier, proves the decode path. |
| 2.2 | Balance reconstruction over those 1,000 blocks, reconciled against a `System.Account` read at the range's end block. If reconstructed ≠ actual, the fold is wrong and it is 1,000 blocks of debugging, not 8.9M. |
| 2.3 | **Full event index backfill.** The one expensive step. Upgrade to Pro, run ~25 hours, resumable and checkpointed. |

2.3 does not start until 2.1 and 2.2 are green *and* Phase 1's composite is validated — §11 explains
why a wrong price series poisons a year of cost-basis assignments that cannot be cheaply recomputed.

**Before 2.3 runs at full scale, two things the 2.1/2.2 implementation deliberately deferred needed
addressing — both were called out as simplifications in `ingestChainRange.ts`'s own comments:**

1. **Runtime-upgrade detection — implemented (2026-08-26).** `pnpm chain:backfill`
   (`packages/ingest/src/scripts/backfillChainEvents.ts`) replaces the Phase 2.1/2.2 tracer-bullet
   script for the real backfill. It processes the range in `CHAIN_CHUNK_BLOCKS`-sized chunks
   (default 100,000) and, per chunk, calls `detectRuntimeSegments`
   (`packages/ingest/src/chain/detectRuntimeUpgrades.ts`) to find every spec_version boundary via
   binary search (`state_getRuntimeVersion` at O(log range) blocks, not every block — a chunk with
   no upgrade costs 4 extra RPC calls, not 100,000). Each distinct spec_version's metadata is
   fetched once and cached to `chain/metadata/{spec_version}.parquet` the first time it's seen, and
   every bronze events row is stamped with the spec_version actually active over its segment —
   `materializeChainSilver.ts` already looked up metadata per-row by `spec_version` and failed
   loudly on a cache miss, so this was purely an ingestion-side fix. Discovered segments are also
   logged to `/meta/runtime_versions.parquet` (`runtimeVersionsLog.ts`) as an audit trail. The
   backfill is resumable: `backfillCheckpoint.ts` writes `/meta/chain_backfill_checkpoint.json`
   after each chunk's bronze is durably written, so a restart resumes at the next chunk instead of
   redoing the range or silently skipping blocks (bronze file names are block-range-keyed, so
   redoing an uncommitted chunk after a crash just overwrites the same file with the same bytes).
   `TO_BLOCK` defaults to the live chain head via `chain_getHeader` (`fetchChainHead.ts`) rather than
   a hardcoded genesis-to-date estimate.
2. **RU sizing / throughput re-measured on Pro (2026-08-26), and it surfaced a second gap beyond
   RU cost.** Two real samples against Pro, both via `pnpm chain:ingest` on recent (non-genesis)
   windows:
   - **Sample 1** — blocks 8,918,000–8,920,000 (2,001 blocks), `CHAIN_CONCURRENCY=1` (the original
     sequential fetch), `CHAIN_MAX_RPM=2000`. Result: 6,006 RPC calls in **877s** — only ~6.85
     calls/s, nowhere near the 2000/min (33/s) cap. The bottleneck was per-call network round-trip
     latency (~270ms), not the rate limit, because every call was awaited one at a time. Projected
     over the full ~8.9M-block range: **~45 days** — far past the plan's ~25–37h estimate.
   - **Fix implemented**: `fetchBlockRange` (`packages/ingest/src/chain/fetchBlockRange.ts`) now
     takes a `concurrency` option and fetches multiple blocks in flight via a worker pool (each
     block's two `state_getStorage` reads also go out concurrently once its hash is known), instead
     of one block at a time. Order-preserving, fails loudly and stops scheduling new work on the
     first error. Both `chain:ingest` and `chain:backfill` expose this as `CHAIN_CONCURRENCY`
     (default 1, unchanged behavior unless set).
   - **Sample 2** — a fresh window, blocks 8,920,001–8,922,000 (2,000 blocks),
     `CHAIN_CONCURRENCY=20`, `CHAIN_MAX_RPM=3000`. Result: 6,003 calls in **123s** — ~7x faster than
     Sample 1. The log shows *why*: the first ~2,900 calls landed in ~11s (a genuine ~260 calls/s
     burst rate), then execution stalled for ~50s once the 3000/min sliding-window budget was
     exhausted, before resuming at the same burst rate for the remainder. **This means concurrency
     removed the latency bottleneck entirely — the rate limiter (`CHAIN_MAX_RPM`) is now the actual
     constraint**, and the achievable burst rate (~260 calls/s) comfortably exceeds Pro's documented
     200 calls/s (12,000 req/min) cap. Sustaining close to that cap over the full backfill projects
     to **~37 hours** — matching the plan's original estimate — *if* Pro's server-side limiter
     accepts sustained traffic at that rate without extended 429 backoff; this hasn't been confirmed
     against a run long enough to find the real sustained ceiling (both samples were short bursts
     against a fairly low `CHAIN_MAX_RPM` cap, not a sustained run near Pro's actual limit).
   - **Follow-up samples (same day) isolated the real bottleneck and found two more bugs.** A
     20,001-block sample at `CHAIN_CONCURRENCY=80` hit the *same* ~9s-burst/~52s-idle throughput
     cycle as concurrency 30 (110.9 vs. 104.7 calls/s — barely different). Suspecting the client's
     own rate limiter, `rpcClient.ts`'s limiter was rewritten from a sliding window (which frees an
     entire minute's budget in one lump when the oldest call ages out — the likely source of the
     burst/stall cycle) to a continuously-refilling token bucket; a dedicated test locks in the
     smooth-refill behavior. Rerunning the same scenario, though, reproduced the *identical*
     burst/stall cycle at nearly the same throughput (117.7 calls/s) — proving the limiter was never
     the actual bottleneck (a token bucket with unused headroom cannot itself impose a wait). A
     third sample at `CHAIN_CONCURRENCY=200` confirmed it again (112.8 calls/s, same cycle). **Real
     sustained throughput plateaus at ~110-120 calls/s regardless of concurrency (30/80/200) or
     limiter design — almost certainly a soft, non-429 throttle on Blockmachine's side.** Revised
     full-backfill projection at this ceiling: **~65-70 hours (~2.7-3 days)**.
   - **Two bugs found and fixed along the way, both real risks to the actual backfill:**
     1. `packages/ingest/src/bronze/parquetWriter.ts` built the whole NDJSON payload as one JS
        string (`rows.map(...).join("\n")`) before writing — a 20,001-block sample's combined
        payload exceeded V8's ~512MB-1GB single-string ceiling (`RangeError: Invalid string
        length`), and the default full-backfill chunk size (100,000 blocks) is 5x larger. Fixed by
        streaming rows to disk one at a time; a ~100MB regression test locks this in.
     2. The fix above initially left the staging-file cleanup only around the later DuckDB step —
        a failure during the write itself (found for real via a subsequent `ENOSPC`: the write
        host's disk was nearly full independent of this work, ~920MB free out of 381GB) skipped
        cleanup entirely, leaking a large temp file. Fixed by widening the `finally` to cover the
        whole staging-then-copy sequence; a regression test forces a write failure and asserts no
        temp file survives it.
   - **RU cost itself**: still needs reading off the Blockmachine dashboard for these samples
     (~192,000 combined RPC calls across the day) to confirm the ~13.5–27M RU projection before
     committing Pro's 20M monthly quota to the full pull.
   - **Open before a full run:** the write host needs real free disk space — some block ranges
     produce staging files far larger than a typical 20,001-block sample, and the full backfill's
     default 100,000-block chunks will be worse. 920MB free is not enough headroom. (Resolved same
     day — the low free space turned out to be unrelated browser cache growth, not this work; 8.9GB
     free confirmed before the full run started.)
   - **The full backfill started 2026-08-26**, `FROM_BLOCK=1`, `CHAIN_CHUNK_BLOCKS=20000`,
     `CHAIN_MAX_RPM=11500`, `CHAIN_CONCURRENCY=50`, `TO_BLOCK` auto-pinned to the head at start
     (8,929,643) via the checkpoint (see next bullet). User-run in their own terminal, not tied to
     an agent session, given the ~2.7-3 day duration.
   - **Checkpoint resumability fix**: if `TO_BLOCK` is left unset, `backfillChainEvents.ts` used to
     re-resolve "current chain head" on *every* run — which moves every ~12s, so a restart's
     recomputed `toBlock` would never match the checkpoint's pinned value, silently discarding
     resumability and restarting from `FROM_BLOCK`. Fixed: `readCheckpointToBlock` in
     `backfillCheckpoint.ts` looks up a previous run's pinned `toBlock` for the same `fromBlock`
     (ignoring whatever the caller would otherwise recompute) so the head is resolved exactly once,
     on the very first run, and every subsequent restart reuses it automatically.

**Monthly reconciliation checkpoints — implemented 2026-08-26, ahead of full-backfill completion,
against whatever prefix of history is already backfilled** (valid because the backfill runs
genesis-forward, so any completed prefix is a real, contiguous slice of history with no missing
baseline — the same property that makes it safe to build Phase 3 metrics against a partial range,
see below). Two real gaps found and fixed:

1. **`reconcileBalances` double-counted history for any non-genesis window.** It loaded *every*
   event currently in silver regardless of the requested range and folded all of them on top of a
   real on-chain baseline taken at `fromBlock - 1` — correct only when `fromBlock = 1` (nothing
   exists before genesis to double-count), which is the only way it had ever been invoked (Phase
   2.2). The first non-genesis checkpoint would have folded pre-window events a second time on top
   of a baseline that already reflected them. Fixed: events are now filtered to
   `fromBlock <= blockNumber <= toBlock` before folding.
2. **No incremental checkpoint runner existed** — `reconcileBalances` only ever checked one
   caller-supplied window, with no way to chain windows together efficiently. Added
   `knownGoodBalances` (optional) to `reconcileBalances`: coldkeys already validated by an earlier
   checkpoint are carried forward as trusted starting balances instead of re-fetching a real
   on-chain read for them, and the function now returns the full resulting `balances` map (not just
   touched-coldkey rows) so it composes across checkpoints. `runReconciliationCheckpoints.ts`
   (`pnpm chain:reconcile-checkpoints`, env: `FROM_BLOCK`, `UP_TO_BLOCK`,
   `CHECKPOINT_INTERVAL_BLOCKS` default 216,000 ≈ 30 days at 12s/block) walks consecutive windows
   from genesis to `UP_TO_BLOCK` (normally whatever `chain:materialize-silver` has actually decoded,
   *not* the live chain head), threading validated balances forward — the same idea as reconciling a
   bank statement against last month's already-agreed closing balance rather than re-checking your
   entire transaction history every month. Both changes are covered by fixture-backed tests using
   the recorded real metadata in `fixtures/chain/` (no live chain access needed to test).

**Still not run successfully for real** (last tried 2026-09-05, see Phase 3's 3.1 entry below for the
full account — three attempts against the real backfilled prefix all failed before ever reaching a
verdict: a real memory bug in `loadEventsFromSilver` unrelated to `UP_TO_BLOCK`, then RPC rate-limit
contention with the concurrently-running `chain:backfill`, then the account's monthly RU budget
running out entirely). The memory bug is fixed and tested; the run itself still needs to happen once
RUs are available again. Two of those three blockers are now gone — the backfill finished on
2026-09-06 so nothing competes for rate limit any more, and silver covers the full range, so
`UP_TO_BLOCK=8929643`. What remains is budget, and sizing the run before spending it (item 3 below). Also not yet built: persisting each checkpoint's raw `System.Account` reads
to `chain/checkpoints/{date}.parquet` per §2's bronze layout (currently the checkpoint reads happen
but aren't archived to bronze) — deferred, not required to validate the fold's correctness, only to
avoid re-fetching the same ground-truth reads if reconciliation is rerun.

**Done when:** the event index is in bronze, reconciles against monthly checkpoints, and every row's
`spec_version` reflects the runtime actually active at that block. (This was relaxed from "full" to
"partial" on 2026-08-26 to avoid blocking on a multi-day background job; the full index landed
2026-09-06 anyway, so the relaxation no longer matters — only the "reconciles against monthly
checkpoints" clause is still outstanding.)

**Before trusting Phase 3's numbers, close out what 2.3 left open** (added 2026-08-27; status as of
2026-09-09, the next session's actual starting point):

1. ✅ **Done 2026-09-06** — `chain:backfill` reached the head it pinned at first run:
   `data/meta/chain_backfill_checkpoint.json` reads `lastCompletedBlock: 8929643` of 8,929,643.
   Cost ~26.8M RPC calls at a measured 3.0 calls/block; see §4.2's "Measured on Pro" note for what
   that implies about RU pricing and why it outran a monthly quota partway.
2. ✅ **Done 2026-09-08** — `chain:materialize-silver` has decoded the whole range: 102,358,339
   transfers, 235,553,651 balance events, 3,306,536 stake events, with 16 blocks (not 2, as first
   recorded) skipped on decode failure — all runtime-upgrade blocks decoded with the wrong metadata,
   fixed and repaired 2026-09-28 (README, "Runtime-upgrade blocks"). Two things were found
   and fixed getting there, both worth knowing before the next long local run — see the README's
   "Decoding bronze -> silver at full scale": the resume path was **not idempotent** and had
   silently duplicated one batch into silver (1,447 duplicate transfer rows in blocks
   5,425,008–5,427,996, since repaired), and a hard power-off can leave the JSON checkpoint
   NUL-filled while the staging DB stays intact, which is recoverable.
3. ✅ **Run for real 2026-09-28: the fold reconciles** — 42 windows, genesis to 9,072,000, 319
   dust-sized mismatches out of ~1.23M coldkey checks (largest 0.0095 TAO, net 0.005 TAO), all after
   block 4.97M. See the README's "Full genesis-to-head run done" for the three reconciler fixes it
   took and what it does and doesn't settle for `account_balances_daily`. Earlier status, kept for
   history: **Sized 2026-09-09, not yet run — now the only remaining step.** Run `chain:reconcile-checkpoints`
   with `UP_TO_BLOCK=8929643` (silver now covers the full range, so the old "once it's caught back up"
   caveat is gone). Three real-data attempts on 2026-09-05 all failed before reaching a verdict (see
   Phase 3.1's entries below); this has still never completed against real (non-fixture) chain data.
   `packages/pipeline/src/scripts/estimateReconciliationRpc.ts` (built 2026-09-09; logic in
   `packages/pipeline/src/chain/estimateReconciliationRpc.ts`, fixture-tested in
   `estimateReconciliationRpc.query.test.ts`) estimates the call count locally with no RPC, as a
   single DuckDB query over silver bucketing block_number by window — exactly mirroring
   `reconcileBalances`'s touched/newly-touched accounting. **Run against the real full range:
   1,181,375 actual-balance reads + 492,669 baseline reads + 123 window-overhead calls = 1,674,167
   total calls ≈ 1.67M RU at ~1 RU/call (§4.2) — about 8% of Pro's 20M/month quota.** The concern
   that motivated sizing this first (a naive 41-windows-of-505K-coldkeys guess could have overshot
   the monthly quota the backfill itself blew through) didn't materialize: reconciliation is far
   cheaper than the backfill because most of the 505,493 coldkeys are touched once, not every
   window. Budget is no longer the open question — the run itself just needs to happen.
5. **Found and fixed 2026-09-11, before the run happened: budget was solved but wall-clock time
   wasn't.** `reconcileBalances` awaited one `state_getStorage` call per coldkey at a time — the
   same latency-bound shape §6's Phase 2 samples already diagnosed for `chain:backfill` (~270ms/call
   RTT, not the rate limit, dominates at concurrency 1). Projected over 1,674,167 calls: **~5 days**,
   despite the RU cost being trivial. Fixed the same way `fetchBlockRange.ts` was: both of
   `reconcileBalances`'s per-coldkey passes now run through a small worker pool
   (`mapWithConcurrency`, `packages/pipeline/src/chain/concurrency.ts`), controlled by the same
   `CHAIN_CONCURRENCY` env var the backfill uses. See the README's "Phase 2.3 — reconciliation
   checkpoints" section for the full note, including that reconciliation's call shape (single reads,
   not two-per-block) hasn't yet been confirmed to hit the backfill's measured ~110-120 calls/s
   ceiling — worth a short real sample before committing to the full range.
6. **First real run against live chain data, 2026-09-11 (small samples, blocks 1-20,000) — both the
   fix above held up, and it immediately found a second, previously-unknown real gap.** Concurrency
   50 and cross-run checkpointing both worked cleanly against the live API. But the sample surfaced
   `Balances.DustLost` — the runtime reaping an account once a mutation drops its free balance below
   the existential deposit — as never having been decoded at all (`normalizeBalanceEvent` only
   handled `Transfer`/`Deposit`/`Withdraw`), leaving reaped accounts with a phantom leftover balance
   in the fold forever. 5,080 of 6,383 touched coldkeys mismatched before the fix; 0 after, once
   reconciled against a freshly `DustLost`-inclusive silver (verified via a local mirror of that
   block range's real bronze, not the full 8.9M-block one). Fixed by normalizing `DustLost` to a
   `withdraw` `BalanceEvent` (`packages/core/src/events/normalize.ts` — same two-field shape as
   `Withdraw`, so no core-reducer change was needed), backed by a real fixture
   (`fixtures/chain/block-9809-dustlost.json`, mainnet block 9809). **The real, full-range
   `data/silver/balance_events.parquet` still predates this fix and needs a full
   `chain:materialize-silver` rerun (hours, local-only, no RPC) before the full genesis-to-head
   reconciliation reflects it** — that rerun, not RPC budget or throughput, is now the long pole
   before Phase 3's numbers can be confirmed. See the README's "Decoding bronze -> silver at full
   scale" and "Phase 2.3 — reconciliation checkpoints" sections for the full account.
4. Phase 3's `account_balances_daily` (3.1) and the two wallet-count series have now been built and
   run against the **complete** index, but still ahead of step 3 passing — **their numbers remain
   provisional** until reconciliation actually confirms the fold. There is now hard evidence that
   caveat is load-bearing rather than ceremonial: `account_balances_daily` contains 116,930
   negative-balance rows across 10,620 distinct coldkeys (~2% of 505,493), which is impossible for a
   real on-chain balance — see 3.3 below and §10's genesis-funded-accounts trap. Don't build further
   Phase 3 work (3.2 exchange labels are RPC-free and fine to continue; 3.3 needs 3.1's numbers to be
   trustworthy) until step 3 comes back clean.

### Phase 3 — Chain metrics (chart 4, plus exchanges)

| Slice | Delivers |
|---|---|
| 3.1 | `account_balances_daily` from the full index; wallet counts, all three series (§7.1); chart 4 |
| 3.2 | Exchange label set (§7.2) — manual research, can start any time from Phase 1 onward |
| 3.3 | Exchange balances chart, falls out of 3.1 + 3.2 at zero marginal cost |

**3.1 built against the complete index as of 2026-09-09, and still provisional:
`chain:reconcile-checkpoints` has never completed successfully against real chain data.** The
original 2026-09-05 blockers were RPC rate-limit contention with the then-concurrent
`chain:backfill`, and then the monthly RU budget running out entirely; the first is gone (backfill
finished 2026-09-06) and the second is the remaining one. `account_balances_daily` and the two
wallet-count series below were built and materialized ahead of reconciliation passing, deliberately,
to validate the SQL/registry pipeline at zero RU cost — **their numbers are not verified against
on-chain ground truth** and must not be treated as final until a `chain:reconcile-checkpoints` run
comes back clean. 3.3 below quantifies exactly how unverified they are.

- Added to `data/meta/metrics_registry.yaml`: `account_balances_daily` (internal, `export: false` —
  sparse per-coldkey, per-day-with-activity free balance, folding signed deltas from
  `silver_transfers` + `silver_balance_events` and running-summing them in event order, block_number
  then event_index; NOT forward-filled to every calendar day — that cross product is 232K coldkeys ×
  ~825 days ≈ 191M rows, intractable given how many times plain memory limits bit this session already)
  and `wallet_count_free_balance` / `wallet_count_dust_filtered` (§7.1 series 1 and 3), which turn the
  sparse table into a continuous daily series via crossing-detection (does a coldkey's
  above-threshold/below-threshold state change between consecutive sparse rows?) plus a
  gaps-and-islands forward-fill, rather than materializing the full dense cross product.
- **Series 2 (stake > 0) is not built** — §4.2's known gap still stands: stake events are keyed by
  hotkey, not coldkey, and turning that into "coldkeys with stake > 0" needs a hotkey→coldkey mapping
  via the `Owner` storage item. That's an RPC job, so it's blocked on RU budget same as reconciliation.
- Real output (2026-09-09, complete index through block 8,929,643): wallet count grows from 8
  coldkeys at genesis (March 2023) to **373,113** (free balance > 0) / **94,392** (dust-filtered,
  > 0.01 TAO), over 1,256 daily points. `account_balances_daily` itself is 4,161,851 rows across
  505,493 distinct coldkeys. Still a coherent, monotonically-growing adoption curve, which is a good
  sign the fold logic is doing something sane even before reconciliation formally confirms it.
  (Superseded numbers, for continuity with older notes: the 2026-09-05 run against the ~5.83M-block
  prefix gave 179,290 / 55,745.)
- **`account_balances_daily` was rewritten to v2 on 2026-09-09** — see the registry changelog for
  the full argument. It aggregates deltas per (coldkey, day) *before* the running sum rather than
  running-summing every event and keeping each day's last row. Same definition, two reasons: v1 tied
  its last-row-of-day pick whenever a coldkey's day ended in a self-transfer (a transfer's two legs
  share one `(block_number, event_index)`), returning a balance off by the transfer amount
  non-deterministically; and v1 could not complete at full scale at all — it sorted ~440M delta rows,
  ran 2h48m and then 4h+ without finishing, and twice exhausted the temp directory. v2 runs in ~7min.
  The registry also gained `shard_by`, which computes a metric one hash-bucket of a column at a time
  with a checkpoint per bucket (progress, bounded memory, resumable) — necessary but *not*
  sufficient here, because hash buckets balance keys and not rows and one pallet-derived account
  holds ~44% of all transfer legs in a single unsplittable partition.
- Bug fixed in the same pass, worth remembering for the next registry entry that touches chain
  silver: `materializeGold` only created a `silver_transfers` view when `transfers.parquet` existed,
  with no equivalent fallback for `silver_balance_events` — any entry referencing it (this was the
  first) crashed the *entire* gold materialization loop, including every entry after it, whenever
  `balance_events.parquet` was absent (e.g. `goldExport.golden.test.ts`'s fixture, which predates
  balance-event decoding). Fixed by giving a missing `balance_events.parquet` an empty-but-correctly-
  typed fallback view instead of erroring — "no deposits/withdraws decoded yet" is a valid empty set,
  not a reason to take down every other metric.

**3.3 built same day — concretely confirms why reconciliation matters, not just in theory.**
`exchange_balances_daily` (§7.2, sums account_balances_daily for the labeled coldkeys in
`data/meta/exchange_labels.json`) went **negative** for several days in March 2023 when run against
real data — down to -9,154.6 TAO on 2023-03-21 — which is impossible for a real on-chain balance.
Traced to one specific coldkey, `5FqBL928choLPmeFz5UVAvonBD5k7K2mZSXVC9RkFzLxoy2s` (labeled MEXC):
its very first appearance in the fold is already negative, meaning it sent out TAO our event fold
never saw it receive — the exact "genesis-funded accounts" gap `reconcileBalances.ts`'s docstring
already describes (a coldkey funded directly in genesis state, before block 1, with no `Deposit`
event ever emitted for it — `account_balances_daily` has no genesis baseline at all, unlike
`reconcileBalances`, which gets one from a real `System.Account` read). Deliberately **not
patched with a clamp/floor** — a negative number is an honest signal that data is missing; hiding it
behind `MAX(balance, 0)` would just replace an obviously-wrong number with a plausible-but-still-wrong
one. The real fix is the same one reconciliation already needs: a real on-chain balance read for any
coldkey touched before its first fold event, which needs RPC (blocked on RU budget same as
everything else in §6). Left as further concrete evidence for the "provisional" caveat — first thing
to check once `chain:reconcile-checkpoints` finally runs.

**Re-measured 2026-09-09 against the complete index, and it is not a March-2023 curiosity.** The
same -9,154.6 TAO floor is still there (10 negative days on `exchange_balances_daily`), but the
underlying gap is far wider than the one MEXC coldkey: `account_balances_daily` now has **116,930
rows with a negative balance, across 10,620 distinct coldkeys** — about 2% of all 505,493 coldkeys
in the fold. Every one of those is an account that spent TAO the event fold never saw it receive.
This is the single best argument for treating Phase 3's numbers as provisional: it is a *lower*
bound on the damage, since a genesis-funded coldkey that never spends below its invisible starting
balance stays quietly positive and wrong rather than visibly negative. Sizing the fix is part of
sizing reconciliation — both need the same per-coldkey `System.Account` reads.

### Phase 4 — Supply in profit (chart 5)

| Slice | Delivers |
|---|---|
| 4.1 | Cost-basis reducer in `core`, unit tested under both emission rules, decision documented in the registry before any materialization runs |
| 4.2 | Join to composite price at block timestamp; `supply_in_profit_daily`; chart 5, labeled "estimated cost basis" |

### Phase 5 — Hardening

Nightly orchestration end to end, gap alarms that actually reach you, monthly checkpoint
reconciliation as a scheduled job, registry version enforcement in CI, **downgrade Blockmachine to
Standard ($9)**. Only after charts are stable — §11 expects 2–3 schema passes.

---

## 7. Metrics — implementation notes

### 7.1 Wallet count

Derive from the event index, not from daily snapshots. Iterating `System.Account` for hundreds of
thousands of accounts is thousands of paged requests *per snapshot*; times 1,100 days that is
hundreds of millions of requests — far more than the event index itself.

Instead: index transfers and stake events once, reconstruct balances locally for every day.
Snapshots become **monthly reconciliation checkpoints** (~13 of them) to verify reconstructed
balances haven't drifted, not a daily ingestion job.

Track **three separate series** — conflating them produces a misleading chart:

1. Coldkeys with free balance > 0
2. Coldkeys with stake > 0
3. Dust-filtered count (> 0.01 TAO) — strips airdrop and dust noise

**Critical:** distinguish coldkeys from hotkeys. Counting both inflates the number and is wrong.
Never store a bare `address` column — this is enforced by the branded types and the no-`address`-column
test in §3, not by remembering.

### 7.2 TAO on exchanges

No vendor sells this. Build the label set manually:

- Seed from Taostats explorer wallet tags (starting point, not a dependency)
- Cross-reference published exchange proof-of-reserves
- Confirm by depositing a small amount to a personal exchange deposit address and observing the
  sweep destination

Store in `/meta/exchange_labels.json` with coldkey, exchange, confidence, date_added, evidence.
Once ~10–15 coldkeys are labeled, balance history falls out of the event index at zero marginal
cost.

**Needs periodic re-auditing** — exchanges rotate wallets. Flag labeled coldkeys that go to zero
and stay there.

**Seeded 2026-09-05** — `data/meta/exchange_labels.json` has 11 coldkeys from Taostats' own
`/api/exchange/v1` endpoint (`TAOSTATS_API_KEY` in `.env`; free tier is sufficient, confirmed by
actually calling it), all at `confidence: "medium"` since this is only the first of the plan's three
sourcing steps — none of these are cross-referenced against a published proof-of-reserves or
confirmed by a deposit-and-observe test yet. Two coldkeys each for Kraken and Binance (separate hot/
cold or operational wallets under the same label); one each for Gate.io, Crypto.com, MEXC, Bitget,
Bithumb, KuCoin. One entry (Taobridge) is flagged `confidence: "low"` and called out as a cross-chain
bridge, not a centralized exchange — worth a decision on whether it belongs in the "TAO on exchanges"
series at all before 3.3 sums balances by label. This clears the plan's own "~10–15 coldkeys" bar
(§7.2) for wiring up exchange balances at effectively zero further labeling effort, though 3.3 itself
is still blocked on 3.1's reconciliation the same as everything else downstream of the fold.

### 7.3 Supply in profit — the hard one

Bittensor is account-based, not UTXO. There is no coin-level cost basis. This is an
**account-level approximation** and must be labeled as such.

**Requires** the full event index from genesis (~8.9M blocks): every `Balances.Transfer`, stake,
unstake, and emission event. This is the one expensive backfill in v1.

**Method:**
1. Maintain running weighted-average cost basis per coldkey, accumulated in integer rao — never floats
2. Mark each inflow at the composite TAO/USD price at that block's timestamp (join from §4.1)
3. `supply_in_profit` = share of circulating supply held by coldkeys whose basis < spot

**Decide and document the emission rule up front.** Does mined/staking-reward TAO enter at zero
basis, or at market price on receipt? This materially moves the chart. The reducer takes the rule as
a parameter and is unit tested under both; the chosen value is written into the metric registry so
the chart is self-documenting.

**Do not call this MVRV.** It isn't. Label it "estimated cost basis."

---

## 8. Metric registry — build this in Phase 0

With five charts, bespoke SQL per chart is tempting. Don't. The registry is a half-day now and is
effectively unbuildable retroactively once there are forty charts — which is the stated direction.
It ships in Phase 0 with one entry, so the pattern exists before there is anything to migrate.

`/meta/metrics_registry.yaml`, one entry per metric, loaded through a Zod schema so a malformed
entry fails at startup with a line number rather than mid-materialization:

```yaml
- name: wallet_count_dust_filtered
  version: 1
  definition: "Count of coldkeys with balance > 0.01 TAO, excluding hotkeys. Threshold inclusive."
  params:
    dust_threshold_rao: 10000000
  sql: "..."
  depends_on: [account_balances_daily]
  changelog:
    - v1: initial
```

Gold materialization iterates the registry in dependency order. Shared concepts (circulating supply,
active coldkeys, composite price) are defined **once** and referenced — otherwise you end up with two
charts that disagree because they filtered dust differently.

**Every gold row carries the metric version that produced it.** When a chart looks wrong in two
years, you can answer *why* instead of guessing. The golden-file test in §5 is what stops a
definition changing without its version.

---

## 9. Deployment

- **Next.js on Vercel Hobby: $0.** 100 GB bandwidth, 1M edge requests, 1M function invocations,
  4 CPU-hours, 100 build minutes monthly. A personal dashboard won't approach any of it.
- **Hobby is personal, non-commercial only.** Fine for v1. Monetising means Pro at $20/seat/month.
- **Nightly job:** rebuild gold → export `gold.json` → push to repo or Vercel Blob → trigger deploy
  hook.
- **The site never queries anything at runtime.** No RPC calls, no R2 access, no API keys in the
  frontend. It reads a static JSON file. This is why it can't break or run up charges.
- **The live edge is the exception:** current price can come from exchange websockets client-side,
  since that data is public and free. Everything historical comes from the gold file. Only the
  rightmost pixel is live.
- **`gold.json` is typed at both ends.** The export writer and the chart components import the same
  `GoldExport` type from `core`. A metric whose shape changes breaks the web build, not the chart.

**Scaling escape hatch (do not build in v1):** if gold JSON ever exceeds ~5–10 MB — which happens
when you move from daily to hourly resolution across many metrics — serve Parquet statically from
Vercel and query it with DuckDB-WASM in the browser via range requests. Same $0 hosting, scales to
gigabytes.

---

## 10. Known traps

| Trap | Mitigation |
|---|---|
| Silent poller death leaves gaps found months later | Gap detection against block height + timestamp continuity, logged to `ingestion_log.parquet`, checked every run, unit tested against a planted hole |
| Runtime upgrades change what a storage item *means* | Stamp every row with block number, timestamp, **and runtime version**. Cache metadata per `spec_version` in bronze. Charts spanning upgrades otherwise silently compare incomparable things. |
| Price errors poison cost basis | Validate §4.1 composite **before** building §7.3 — this is why Phase 1 precedes Phase 4. A year of basis assignments cannot be cheaply recomputed against a corrected price series. |
| First schema will be wrong | Expect 2–3 passes. Bronze exists so passes 2–3 are local recompute. Stay on Pro until charts are stable. |
| Filtered event capture blocks v2 | **Store the entire `System.Events` blob per block, unparsed hex.** You're already paying the RU for the block; capturing all events costs nothing extra in requests and ~3–5× disk. Decode selectively at silver. If bronze only holds transfers, adding subnet metrics in v2 means another full backfill. |
| Many small R2 objects | Write 100–500 MB Parquet files. Millions of tiny objects burn Class A ops and defeat range reads. |
| Rate limit rejections | Exponential backoff; over-limit requests error immediately rather than queueing. Contract tested against a 429 fixture. |
| `number` silently truncating rao | Branded `Rao = bigint` (§3). u64 rao exceeds `MAX_SAFE_INTEGER` at ~9.007M TAO — a reachable balance, not a theoretical one. |
| Coldkey/hotkey conflation | Branded types, no `address` column, asserted by test (§3, §7.1) |
| Genesis-funded accounts have no funding event | Confirmed on mainnet during Phase 2.2 (blocks 1–1000): several coldkeys held tens of thousands of TAO **at block 0**, before any block executed — genesis state is constructed directly, not via an extrinsic, so `Balances.Deposit` never fires for it. A balance fold seeded from an empty map can never reconcile these; it isn't a fold bug, it's a baseline bug. Fix: seed the fold from a real `System.Account` snapshot at `fromBlock - 1`, not an assumed zero (see `reconcileBalances.ts`). **This is a third category §7.3's emission-rule decision doesn't cover** ("mined/staking-reward TAO enter at zero basis, or at market price on receipt?") — genesis TAO has no receipt block at all. Phase 4 needs an explicit rule for it (likely: cost basis = price at genesis timestamp, or documented as zero-basis by convention) before the cost-basis reducer touches these coldkeys. |
| Tests that hit the network | Only smoke checks touch live APIs, and they never gate a commit. A venue outage must not turn the suite red. |
| Metric definition drifts without a version bump | Golden-file snapshot of `gold.json` (§5) — the definition cannot change without the snapshot failing |

---

## 11. Costs

**Backfill, months 1–3**

| Item | Cost |
|---|---|
| Blockmachine Pro | $25/mo |
| Cloudflare R2 (bronze) | ~$0.60/mo |
| Exchange APIs, Vercel, local compute | $0 |
| **Total** | **~$77 for three months** |

Phases 0 and 1 run entirely on free tiers. The Pro plan is only needed from Phase 2.3.

**Steady state**

| Item | Cost |
|---|---|
| Blockmachine Standard | $9/mo |
| Cloudflare R2 | ~$0.60/mo |
| Everything else | $0 |
| **Total** | **~$10/month** |

---

## 12. Rejected options — do not re-litigate

- **Python for ingestion** — `substrate-interface` and the `bittensor` SDK are more mature than
  `@polkadot/api` for chain work, but the site is TypeScript regardless, and a split-language repo
  means duplicated domain types, two test runners, two dependency stories, and a serialization
  boundary between the pipeline and the chart it feeds. One language keeps `GoldExport` a single
  definition. `@polkadot/api` covers everything v1 needs: raw storage reads and metadata-driven
  SCALE decoding.
- **A JavaScript Parquet library** — DuckDB writes every Parquet file (§2). Two writers means two
  type-mapping behaviours and eventual disagreement about round-tripping.
- **Floats for on-chain amounts** — see §3 and §10.
- **Taostats API ($49–199/mo)** — sells derived analytics we compute ourselves; licensed data with
  redistribution restrictions. Free tier is useful as a cross-check on our own numbers, nothing more.
- **CoinGecko paid tiers ($35–129/mo)** — unnecessary for personal use. Exchange APIs give the same
  data free. Free Demo tier is fine for one-off calibration of the volume composite.
- **Self-hosted subtensor archive node** — 4–6 TB NVMe and rising, days-to-weeks initial sync,
  24/7 uptime requirement on a machine that sleeps. ~30+ months to break even against $9/mo, and
  it does not remove any indexing work: the chain does not store aggregates either way. Only flips
  if per-block resolution across all history becomes necessary, which nothing in v1 requires.
- **Postgres / TimescaleDB** — DuckDB over Parquet is faster for single-user analytical scans and
  needs no server process.
- **Hippius (SN75) or other decentralized storage as primary** — S3-compatible, but ~18 months old
  and data availability depends on subnet miner incentives. Bronze is the one irreplaceable asset;
  the price gap versus R2 is under $3/month, which doesn't buy meaningful risk. Also correlated:
  storing a Bittensor archive on Bittensor. Reasonable as a *second* copy later.
- **Hetzner Storage Box** — cheaper flat rate (€3.20/TB) and the right answer above ~230 GB, but no
  S3 API, so no in-place querying. Revisit in v2 if subnet capture pushes bronze into the hundreds
  of GB.
- **Remote storage mounted as a filesystem** — see §4.3. Never.
- **Building all of bronze before building any chart** — the original build order. It defers the
  first end-to-end validation past the one irreversible spend. Phase 0 exists to invert that.

---

## 13. v2 — explicitly deferred

Not now, but design v1 so these don't require a re-backfill:

- Subnet/alpha token metrics (bronze grows to ~200–500 GB; likely triggers the move to a Storage
  Box and a bigger local disk)
- Monthly checkpointing of derived state, so full rebuilds start from the nearest checkpoint rather
  than genesis — build this the first time a rebuild becomes annoying, not before
- DuckDB-WASM browser querying if gold outgrows static JSON
- Validator yields, APY, emissions breakdowns

The one v1 decision that protects all of this: **capture full `System.Events`, not a filtered
subset** (§10).

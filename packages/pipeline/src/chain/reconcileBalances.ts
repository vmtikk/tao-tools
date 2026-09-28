import { asColdkey, asRao, type BalanceEvent, type BalanceMap, type Coldkey, type Rao } from "@tao-tools/core";
import { systemAccountKey, type BlockmachineClient } from "@tao-tools/ingest";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";
import { buildRegistry } from "./decodeEvents.js";
import { decodeAccountBalances } from "./decodeAccount.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { TypeRegistry } from "@polkadot/types";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Balances here are *total* (free + reserved), not free. The fold only sees
 * Transfer/Deposit/Withdraw/DustLost; moving TAO between free and reserved
 * (identity deposits, registrations, proxies...) changes neither, so what the
 * fold reconstructs is the total. Comparing against free alone would flag
 * every account holding a reserve. Mismatches against the total are genuine
 * missing events: slashes, reserve repatriations, and the like.
 */
export interface ReconciliationRow {
  coldkey: Coldkey;
  baselineRao: bigint;
  reconstructedRao: bigint;
  actualRao: bigint;
  /** Breakdown of `actualRao`, for diagnosing mismatches. */
  actualFreeRao: bigint;
  actualReservedRao: bigint;
  matches: boolean;
}

function totalBalance(registry: TypeRegistry, accountInfoHex: string | null): { free: bigint; reserved: bigint; total: bigint } {
  const { free, reserved } = decodeAccountBalances(registry, accountInfoHex);
  return { free, reserved, total: free + reserved };
}

export interface ReconcileBalancesResult {
  fromBlock: number;
  toBlock: number;
  startBlockHash: string;
  endBlockHash: string;
  touchedAccounts: number;
  rows: ReconciliationRow[];
  /**
   * Balance state as of `toBlock` to carry into the next window: every
   * coldkey from `knownGoodBalances`, with each coldkey touched here set to
   * its *actual* on-chain balance just read, not the reconstructed one. That
   * keeps windows independent: a gap in the fold shows up as a mismatch in
   * the window where it happened, instead of cascading into every later one.
   */
  balances: BalanceMap;
}

/**
 * Net change per coldkey over [fromBlock, toBlock]: transfers debit the
 * sender and credit the recipient, deposits credit, withdraws debit. Every
 * coldkey that appears in the window is present, even with a net change of 0
 * (e.g. a self-transfer) — "touched" is what reconciliation checks.
 *
 * Reconciliation only compares end-of-window balances, and the fold is plain
 * unclamped addition, so the net sum is exactly what an event-by-event fold
 * would end on — without holding the window's events in memory. The full
 * index is ~370M events; the old approach (load all of them into one JS
 * array, then copy the balance map per event) could not run at that scale.
 */
export async function loadWindowNetDeltasFromSilver(fromBlock: number, toBlock: number): Promise<Map<Coldkey, bigint>> {
  const transfersPath = escapeSqlLiteral(`${silverDir()}/transfers.parquet`);
  const balanceEventsPath = escapeSqlLiteral(`${silverDir()}/balance_events.parquet`);
  const window = `block_number BETWEEN ${Math.trunc(fromBlock)} AND ${Math.trunc(toBlock)}`;
  const rows = await withDuckDb(
    async (connection) =>
      connection
        .run(
          `WITH deltas AS (
             SELECT from_coldkey AS coldkey, -amount_rao AS delta FROM read_parquet('${transfersPath}') WHERE ${window}
             UNION ALL
             SELECT to_coldkey, amount_rao FROM read_parquet('${transfersPath}') WHERE ${window}
             UNION ALL
             SELECT coldkey, CASE kind WHEN 'deposit' THEN amount_rao ELSE -amount_rao END
             FROM read_parquet('${balanceEventsPath}') WHERE ${window}
           )
           SELECT coldkey, CAST(SUM(delta) AS BIGINT) FROM deltas GROUP BY coldkey;`,
        )
        .then((r) => r.getRows()),
    // See session.ts's memoryLimit doc comment: DuckDB auto-sizes its buffer
    // pool against total system RAM, too optimistic alongside other jobs.
    { memoryLimit: "3GB" },
  );
  return new Map(rows.map((row) => [asColdkey(String(row[0])), BigInt(row[1] as bigint)]));
}

/** Same as {@link loadWindowNetDeltasFromSilver}, over an in-memory event list (tests, small ranges). */
export function netDeltasFromEvents(events: readonly BalanceEvent[], fromBlock: number, toBlock: number): Map<Coldkey, bigint> {
  const deltas = new Map<Coldkey, bigint>();
  const add = (coldkey: Coldkey, amount: bigint) => deltas.set(coldkey, (deltas.get(coldkey) ?? 0n) + amount);
  for (const event of events) {
    if (event.blockNumber < fromBlock || event.blockNumber > toBlock) continue;
    if (event.kind === "transfer") {
      add(event.from, -event.amount);
      add(event.to, event.amount);
    } else {
      add(event.coldkey, event.kind === "deposit" ? event.amount : -event.amount);
    }
  }
  return deltas;
}

async function loadRegistryForBlock(client: BlockmachineClient, blockHash: string): Promise<TypeRegistry> {
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");
  const runtimeVersion = await client.call<{ specVersion: number }>("state_getRuntimeVersion", [blockHash]);

  const bronzeMetadataHex = await withDuckDb(
    async (connection) => {
      try {
        const result = await connection.run(
          `SELECT metadata_hex FROM read_parquet('${escapeSqlLiteral(bronzeUri)}/chain/metadata/${runtimeVersion.specVersion}.parquet') LIMIT 1;`,
        );
        const rows = await result.getRows();
        return rows[0] ? String(rows[0][0]) : null;
      } catch {
        return null;
      }
    },
    { needsR2: isRemote },
  );

  if (bronzeMetadataHex) return buildRegistry(bronzeMetadataHex);

  // Bronze doesn't have this spec_version cached (a runtime upgrade the
  // ingest run didn't cover) — fetch it directly rather than fail. Read-only
  // reconciliation script, so it's fine for this metadata to not get
  // persisted to bronze; a real backfill run would need to (§10).
  const metadataHex = await client.call<string>("state_getMetadata", [blockHash]);
  return buildRegistry(metadataHex);
}

/**
 * tao-analytics-plan.md §6, Phase 2.2: applies each coldkey's net change over
 * [fromBlock, toBlock] to its balance at the window's start, and reconciles
 * each coldkey touched in that window against a real `System.Account` read
 * at the window's end block. "If reconstructed != actual, the fold is wrong
 * and it is 1,000 blocks of debugging, not 8.9M" — this is that debugging
 * tool, not a one-shot assertion: it reports every mismatch, not just
 * whether any exist.
 *
 * **Only the window's own events count.** A later window's starting point
 * already reflects everything before `fromBlock` (a carried-forward balance
 * or an on-chain read at `fromBlock - 1`), so including earlier events would
 * double-count them — the original Phase 2.2 bug, invisible while every call
 * started at genesis.
 *
 * **`knownGoodBalances` (optional) carries forward balances from an earlier
 * window** instead of re-reading them on-chain — only coldkeys touched here
 * for the first time need a fresh `System.Account` read at `fromBlock - 1`.
 * Coldkeys absent from both the window and `knownGoodBalances` were never
 * touched and need no read at all.
 *
 * That start-of-window read is also what handles genesis-funded accounts:
 * several coldkeys held TAO at block 0 with no `Balances.Deposit` ever
 * emitted (genesis state is constructed directly), which a fold seeded from
 * zero can never reconcile. Any coldkey touched for the first time needs a
 * real snapshot at its first window's start, not an assumed zero.
 */
export async function reconcileBalances(opts: {
  fromBlock: number;
  toBlock: number;
  client: BlockmachineClient;
  knownGoodBalances?: BalanceMap;
  /** In-memory events instead of reading the window from silver (tests, small ranges). */
  events?: readonly BalanceEvent[];
  /**
   * Coldkeys in flight at once for each of this function's two
   * `state_getStorage`-per-coldkey passes (fresh baselines, then final
   * balances). Default 1 preserves the original one-at-a-time behavior.
   *
   * Exists for the same reason `chain:backfill`'s `CHAIN_CONCURRENCY` does
   * (see `fetchBlockRange.ts`): a sequential loop here is latency-bound at
   * ~270ms/call RTT, not rate-limit-bound, so `CHAIN_MAX_RPM` alone can't
   * make a real reconciliation run fast.
   */
  concurrency?: number;
}): Promise<ReconcileBalancesResult> {
  const netDeltas = opts.events
    ? netDeltasFromEvents(opts.events, opts.fromBlock, opts.toBlock)
    : await loadWindowNetDeltasFromSilver(opts.fromBlock, opts.toBlock);
  const touchedColdkeys = [...netDeltas.keys()];
  const knownGoodBalances = opts.knownGoodBalances ?? new Map<Coldkey, Rao>();

  const client = opts.client;
  const concurrency = opts.concurrency ?? 1;
  const startBlockHash = await client.call<string>("chain_getBlockHash", [opts.fromBlock - 1]);
  const endBlockHash = await client.call<string>("chain_getBlockHash", [opts.toBlock]);
  const registry = await loadRegistryForBlock(client, endBlockHash);

  const newlyTouched = touchedColdkeys.filter((coldkey) => !knownGoodBalances.has(coldkey));
  const freshBaselines = new Map<Coldkey, bigint>(
    await mapWithConcurrency(newlyTouched, concurrency, async (coldkey) => {
      const hex = await client.call<string | null>("state_getStorage", [systemAccountKey(coldkey), startBlockHash]);
      return [coldkey, totalBalance(registry, hex).total] as const;
    }),
  );

  const rows = await mapWithConcurrency(touchedColdkeys, concurrency, async (coldkey): Promise<ReconciliationRow> => {
    const accountInfoHex = await client.call<string | null>("state_getStorage", [systemAccountKey(coldkey), endBlockHash]);
    const actual = totalBalance(registry, accountInfoHex);
    const baselineRao = knownGoodBalances.get(coldkey) ?? freshBaselines.get(coldkey) ?? 0n;
    const reconstructedRao = baselineRao + netDeltas.get(coldkey)!;
    return {
      coldkey,
      baselineRao,
      reconstructedRao,
      actualRao: actual.total,
      actualFreeRao: actual.free,
      actualReservedRao: actual.reserved,
      matches: reconstructedRao === actual.total,
    };
  });

  const balances = new Map<Coldkey, Rao>(knownGoodBalances);
  for (const row of rows) balances.set(row.coldkey, asRao(row.actualRao));

  return {
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    startBlockHash,
    endBlockHash,
    touchedAccounts: rows.length,
    rows,
    balances,
  };
}

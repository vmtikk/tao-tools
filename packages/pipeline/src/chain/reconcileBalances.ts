import {
  asBlockNumber,
  asColdkey,
  asRao,
  reconstructBalances,
  type BalanceEvent,
  type BalanceMap,
  type Coldkey,
  type Rao,
} from "@tao-tools/core";
import { systemAccountKey, type BlockmachineClient } from "@tao-tools/ingest";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";
import { buildRegistry } from "./decodeEvents.js";
import { decodeFreeBalance } from "./decodeAccount.js";
import type { TypeRegistry } from "@polkadot/types";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export interface ReconciliationRow {
  coldkey: Coldkey;
  baselineRao: bigint;
  reconstructedRao: bigint;
  actualRao: bigint;
  matches: boolean;
}

export interface ReconcileBalancesResult {
  fromBlock: number;
  toBlock: number;
  startBlockHash: string;
  endBlockHash: string;
  touchedAccounts: number;
  rows: ReconciliationRow[];
  /**
   * Full balance state as of `toBlock`, covering every coldkey carried in
   * via `knownGoodBalances` plus anything newly touched by this window's
   * events. Pass this straight back in as the *next* checkpoint's
   * `knownGoodBalances` — that's what makes consecutive checkpoints
   * incremental instead of re-folding genesis-to-date every time.
   */
  balances: BalanceMap;
}

/** Exported so a multi-checkpoint caller (`runReconciliationCheckpoints.ts`)
 * can load silver once and pass the same array to every checkpoint's
 * `reconcileBalances` call, instead of re-reading disk per checkpoint. */
export async function loadEventsFromSilver(): Promise<BalanceEvent[]> {
  const transfersPath = `${silverDir()}/transfers.parquet`;
  const balanceEventsPath = `${silverDir()}/balance_events.parquet`;

  return withDuckDb(async (connection) => {
    const events: BalanceEvent[] = [];

    const transferRows = await connection
      .run(
        `SELECT block_number, event_index, from_coldkey, to_coldkey, amount_rao
         FROM read_parquet('${escapeSqlLiteral(transfersPath)}')
         ORDER BY block_number, event_index;`,
      )
      .then((r) => r.getRows());
    for (const row of transferRows) {
      events.push({
        kind: "transfer",
        blockNumber: asBlockNumber(Number(row[0])),
        eventIndex: Number(row[1]),
        from: asColdkey(String(row[2])),
        to: asColdkey(String(row[3])),
        amount: asRao(BigInt(row[4] as bigint)),
      });
    }

    const balanceEventRows = await connection
      .run(
        `SELECT block_number, event_index, kind, coldkey, amount_rao
         FROM read_parquet('${escapeSqlLiteral(balanceEventsPath)}')
         ORDER BY block_number, event_index;`,
      )
      .then((r) => r.getRows());
    for (const row of balanceEventRows) {
      const kind = String(row[2]) as "deposit" | "withdraw";
      events.push({
        kind,
        blockNumber: asBlockNumber(Number(row[0])),
        eventIndex: Number(row[1]),
        coldkey: asColdkey(String(row[3])),
        amount: asRao(BigInt(row[4] as bigint)),
      });
    }

    events.sort((a, b) => a.blockNumber - b.blockNumber || a.eventIndex - b.eventIndex);
    return events;
  });
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
 * tao-analytics-plan.md §6, Phase 2.2: folds silver balance events for
 * [fromBlock, toBlock] into a `BalanceMap` (§7.1's reducer) and reconciles
 * each coldkey touched in that window against a real `System.Account` read
 * at the window's end block. "If reconstructed != actual, the fold is wrong
 * and it is 1,000 blocks of debugging, not 8.9M" — this is that debugging
 * tool, not a one-shot assertion: it reports every mismatch, not just
 * whether any exist.
 *
 * **Events are filtered to the window** (`fromBlock <= blockNumber <=
 * toBlock`) before folding — this was not true of the original Phase 2.2
 * version, which folded *every* event currently in silver regardless of the
 * requested range. That was invisible as a bug as long as every call started
 * at genesis (fromBlock=1, where "everything before fromBlock" is empty by
 * definition), but folding the full history on top of a `knownGoodBalances`/
 * on-chain baseline already representing state as of `fromBlock - 1` would
 * double-count every event before `fromBlock` for any later window — exactly
 * what `runReconciliationCheckpoints.ts`'s incremental, non-genesis windows
 * need not to happen.
 *
 * **`knownGoodBalances` (optional) carries forward a previously-validated
 * state** instead of re-fetching a real on-chain baseline for coldkeys
 * already reconciled in an earlier checkpoint — the efficiency half of
 * "checkpoint," not just correctness: only coldkeys newly touched in *this*
 * window need a fresh `System.Account` read. Coldkeys absent from both the
 * window's events and `knownGoodBalances` were never touched at all, by
 * definition, and don't need one either — same reasoning `runReconciliation
 * Checkpoints.ts` relies on to skip most of the ledger, most checkpoints.
 *
 * The very first window (whatever its `fromBlock`) still needs a real
 * on-chain baseline for anything newly touched — that's what surfaced the
 * genesis-funded-accounts gap originally: several coldkeys were pre-funded
 * directly in genesis state, present in `System.Account` at block 0 with no
 * `Balances.Deposit` event ever emitted for it (genesis state is constructed
 * directly, not by executing block 1). A fold seeded from zero can never
 * reconcile that — it isn't a bug in the fold, it's a baseline problem, and
 * it generalizes: any coldkey touched for the first time in a window needs a
 * real snapshot at that window's start, not an assumed zero.
 */
export async function reconcileBalances(opts: {
  fromBlock: number;
  toBlock: number;
  client: BlockmachineClient;
  knownGoodBalances?: BalanceMap;
  /** Pre-loaded events, so a multi-checkpoint caller can load silver once
   * instead of once per checkpoint. Defaults to a fresh read from silver. */
  events?: readonly BalanceEvent[];
}): Promise<ReconcileBalancesResult> {
  const allEvents = opts.events ?? (await loadEventsFromSilver());
  const windowEvents = allEvents.filter((e) => e.blockNumber >= opts.fromBlock && e.blockNumber <= opts.toBlock);

  const knownGoodBalances = opts.knownGoodBalances ?? new Map<Coldkey, Rao>();

  const touchedColdkeys = new Set<Coldkey>();
  for (const event of windowEvents) {
    if (event.kind === "transfer") {
      touchedColdkeys.add(event.from);
      touchedColdkeys.add(event.to);
    } else {
      touchedColdkeys.add(event.coldkey);
    }
  }

  const client = opts.client;
  const startBlockHash = await client.call<string>("chain_getBlockHash", [opts.fromBlock - 1]);
  const endBlockHash = await client.call<string>("chain_getBlockHash", [opts.toBlock]);
  const registry = await loadRegistryForBlock(client, endBlockHash);

  // Only coldkeys touched here for the first time (not already carried
  // forward from a prior, validated checkpoint) need a real on-chain read.
  const newlyTouched = [...touchedColdkeys].filter((coldkey) => !knownGoodBalances.has(coldkey));
  const freshBaseline = new Map<Coldkey, Rao>();
  for (const coldkey of newlyTouched) {
    const key = systemAccountKey(coldkey);
    const hex = await client.call<string | null>("state_getStorage", [key, startBlockHash]);
    freshBaseline.set(coldkey, asRao(decodeFreeBalance(registry, hex)));
  }

  const initial = new Map<Coldkey, Rao>(knownGoodBalances);
  for (const [coldkey, rao] of freshBaseline) {
    initial.set(coldkey, rao);
  }

  const reconstructed = reconstructBalances(windowEvents, initial);

  const rows: ReconciliationRow[] = [];
  for (const coldkey of touchedColdkeys) {
    const key = systemAccountKey(coldkey);
    const accountInfoHex = await client.call<string | null>("state_getStorage", [key, endBlockHash]);
    const actualRao = decodeFreeBalance(registry, accountInfoHex);
    const reconstructedRao = reconstructed.get(coldkey) ?? 0n;
    rows.push({
      coldkey,
      baselineRao: initial.get(coldkey) ?? 0n,
      reconstructedRao,
      actualRao,
      matches: reconstructedRao === actualRao,
    });
  }

  return {
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    startBlockHash,
    endBlockHash,
    touchedAccounts: rows.length,
    rows,
    balances: reconstructed,
  };
}

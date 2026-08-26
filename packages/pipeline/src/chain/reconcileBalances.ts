import {
  asBlockNumber,
  asColdkey,
  asRao,
  reconstructBalances,
  type BalanceEvent,
  type Coldkey,
} from "@tao-tools/core";
import { createBlockmachineClient, systemAccountKey, type BlockmachineClient } from "@tao-tools/ingest";
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
}

async function loadEventsFromSilver(): Promise<BalanceEvent[]> {
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
 * tao-analytics-plan.md §6, Phase 2.2: folds every silver balance event into
 * a `BalanceMap` (§7.1's reducer) and reconciles each touched coldkey against
 * a real `System.Account` read at the range's end block. "If reconstructed
 * != actual, the fold is wrong and it is 1,000 blocks of debugging, not
 * 8.9M" — this is that debugging tool, not a one-shot assertion: it reports
 * every mismatch, not just whether any exist.
 *
 * The fold does NOT start from an empty balance map. First run against
 * blocks 1-1000 (genesis) surfaced a real gap this way: several coldkeys
 * were pre-funded directly in genesis state — tens of thousands of TAO each,
 * present in `System.Account` at block 0 with no `Balances.Deposit` event
 * ever emitted for it (genesis state is constructed directly, not by
 * executing block 1, so there's nothing to emit an event). A fold starting
 * from zero can never reconcile that; it isn't a bug in the fold, it's a
 * baseline problem. The fix generalizes to any window, not just genesis:
 * seed the map from a real `System.Account` snapshot at `fromBlock - 1`
 * (the state immediately before this range's first event could apply) for
 * every coldkey the range's events touch, then fold forward from there.
 */
export async function reconcileBalances(opts: {
  fromBlock: number;
  toBlock: number;
  apiKey: string;
  maxRequestsPerMinute?: number;
}): Promise<ReconcileBalancesResult> {
  const events = await loadEventsFromSilver();

  const touchedColdkeys = new Set<Coldkey>();
  for (const event of events) {
    if (event.kind === "transfer") {
      touchedColdkeys.add(event.from);
      touchedColdkeys.add(event.to);
    } else {
      touchedColdkeys.add(event.coldkey);
    }
  }

  const client = createBlockmachineClient({ apiKey: opts.apiKey, maxRequestsPerMinute: opts.maxRequestsPerMinute });
  const startBlockHash = await client.call<string>("chain_getBlockHash", [opts.fromBlock - 1]);
  const endBlockHash = await client.call<string>("chain_getBlockHash", [opts.toBlock]);
  const registry = await loadRegistryForBlock(client, endBlockHash);

  const baseline = new Map<Coldkey, bigint>();
  for (const coldkey of touchedColdkeys) {
    const key = systemAccountKey(coldkey);
    const hex = await client.call<string | null>("state_getStorage", [key, startBlockHash]);
    baseline.set(coldkey, decodeFreeBalance(registry, hex));
  }

  const initial = new Map(Array.from(baseline, ([coldkey, rao]) => [coldkey, asRao(rao)] as const));
  const reconstructed = reconstructBalances(events, initial);

  const rows: ReconciliationRow[] = [];
  for (const [coldkey, reconstructedRao] of reconstructed) {
    const key = systemAccountKey(coldkey);
    const accountInfoHex = await client.call<string | null>("state_getStorage", [key, endBlockHash]);
    const actualRao = decodeFreeBalance(registry, accountInfoHex);
    rows.push({
      coldkey,
      baselineRao: baseline.get(coldkey) ?? 0n,
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
  };
}

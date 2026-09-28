import type { BlockmachineClient } from "./rpcClient.js";
import { SYSTEM_ACCOUNT_PREFIX, coldkeyFromSystemAccountKey } from "./storageKeys.js";
import { resolveBronzeUri } from "../paths.js";
import { writeRowsAsParquet, type WriteRowsAsParquetResult } from "../bronze/parquetWriter.js";

export interface AccountSnapshot {
  blockNumber: number;
  blockHash: string;
  specVersion: number;
  rows: { coldkey: string; storageKey: string; accountInfoHex: string }[];
}

const KEYS_PAGE_SIZE = 1000;
const VALUES_BATCH_SIZE = 500;

/**
 * Every `System.Account` entry at one block, raw (§4.2: no decoding during
 * ingestion). Keys come from `state_getKeysPaged`, values from
 * `state_queryStorageAt` in batches — ~40 calls for genesis's 18,619
 * accounts, rather than one `state_getStorage` per account.
 *
 * Exists to seed the balance fold: accounts endowed directly in genesis state
 * never emit a Deposit event, so a fold starting from zero sends them negative
 * as soon as they spend (tao-analytics-plan.md §10, genesis-funded accounts).
 */
export async function fetchAccountSnapshot(client: BlockmachineClient, blockNumber: number): Promise<AccountSnapshot> {
  const blockHash = await client.call<string>("chain_getBlockHash", [blockNumber]);
  if (!blockHash) throw new Error(`chain_getBlockHash(${blockNumber}) returned no hash`);
  const { specVersion } = await client.call<{ specVersion: number }>("state_getRuntimeVersion", [blockHash]);

  const keys: string[] = [];
  let startKey = SYSTEM_ACCOUNT_PREFIX;
  for (;;) {
    const page = await client.call<string[]>("state_getKeysPaged", [SYSTEM_ACCOUNT_PREFIX, KEYS_PAGE_SIZE, startKey, blockHash]);
    keys.push(...page);
    if (page.length < KEYS_PAGE_SIZE) break;
    startKey = page[page.length - 1]!;
  }

  const valueByKey = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i += VALUES_BATCH_SIZE) {
    const batch = keys.slice(i, i + VALUES_BATCH_SIZE);
    const result = await client.call<{ block: string; changes: [string, string | null][] }[]>("state_queryStorageAt", [batch, blockHash]);
    for (const [key, value] of result[0]?.changes ?? []) valueByKey.set(key, value);
  }

  const rows = keys.map((storageKey) => {
    const accountInfoHex = valueByKey.get(storageKey);
    // Every key came from the same block's key listing, so a missing value
    // means a truncated response — fail loudly rather than write partial bronze (§5).
    if (!accountInfoHex) throw new Error(`No System.Account value returned for ${storageKey} at block ${blockNumber}`);
    return { coldkey: coldkeyFromSystemAccountKey(storageKey), storageKey, accountInfoHex };
  });
  return { blockNumber, blockHash, specVersion, rows };
}

/** bronze/chain/account_snapshots/{block}.parquet — one row per account, raw hex. */
export async function writeAccountSnapshotBronze(snapshot: AccountSnapshot, bronzeUri?: string): Promise<WriteRowsAsParquetResult> {
  const base = (bronzeUri ?? resolveBronzeUri()).replace(/\/+$/, "");
  const destination = `${base}/chain/account_snapshots/${String(snapshot.blockNumber).padStart(9, "0")}.parquet`;
  const rows = snapshot.rows.map((r) => ({
    block_number: snapshot.blockNumber,
    block_hash: snapshot.blockHash,
    spec_version: snapshot.specVersion,
    coldkey: r.coldkey,
    storage_key: r.storageKey,
    account_info_hex: r.accountInfoHex,
  }));
  return writeRowsAsParquet({ rows, destination });
}

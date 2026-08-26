import type { BlockmachineClient } from "./rpcClient.js";
import { SYSTEM_EVENTS_KEY, TIMESTAMP_NOW_KEY } from "./storageKeys.js";

/**
 * One block's raw capture. `eventsHex`/`timestampHex` are exactly what
 * `state_getStorage` returned — no decoding (tao-analytics-plan.md §4.2:
 * "No decoding happens during ingestion — that is what makes bronze
 * re-parseable."). `timestampHex` is captured alongside events, not decoded
 * from the block body, so this stays a 3-call-per-block fetch instead of 4:
 * `pallet_timestamp::Now` is a plain storage read at the same block hash,
 * not an extrinsic to parse.
 */
export interface RawBlockRecord {
  blockNumber: number;
  blockHash: string;
  eventsHex: string;
  timestampHex: string | null;
}

export interface FetchBlockRangeOptions {
  client: BlockmachineClient;
  /** Inclusive. */
  fromBlock: number;
  /** Inclusive. */
  toBlock: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Fetches raw `System.Events` + `Timestamp.Now` for every block in
 * [fromBlock, toBlock], sequentially (the client's own rate limiter paces
 * the requests). Throws on the first failure rather than returning a partial
 * array — §5 Tier 3: "the ingestion worker must fail loudly, never write
 * partial bronze."
 */
export async function fetchBlockRange(opts: FetchBlockRangeOptions): Promise<RawBlockRecord[]> {
  const { client, fromBlock, toBlock, onProgress } = opts;
  if (toBlock < fromBlock) throw new Error(`toBlock (${toBlock}) must be >= fromBlock (${fromBlock})`);

  const total = toBlock - fromBlock + 1;
  const records: RawBlockRecord[] = [];

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber++) {
    const blockHash = await client.call<string>("chain_getBlockHash", [blockNumber]);
    if (!blockHash) {
      throw new Error(`chain_getBlockHash(${blockNumber}) returned no hash — chain hasn't reached this height yet?`);
    }
    const eventsHex = await client.call<string | null>("state_getStorage", [SYSTEM_EVENTS_KEY, blockHash]);
    const timestampHex = await client.call<string | null>("state_getStorage", [TIMESTAMP_NOW_KEY, blockHash]);

    records.push({
      blockNumber,
      blockHash,
      // A block with zero events legitimately returns null (empty Vec, not
      // an error) — normalize to the SCALE-empty-vec encoding so silver's
      // decoder doesn't need a null special case.
      eventsHex: eventsHex ?? "0x00",
      timestampHex,
    });

    onProgress?.(blockNumber - fromBlock + 1, total);
  }

  return records;
}

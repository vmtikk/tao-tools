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
  /**
   * Number of blocks fetched in flight at once. Real in-flight RPC calls run
   * roughly 2x this (each block's two `state_getStorage` reads go out
   * concurrently once its hash is known). Default 1 preserves the original
   * one-block-at-a-time behavior.
   *
   * This exists because the rate limiter alone does not make a backfill
   * fast: measured against a real 2,001-block window on Blockmachine Pro
   * (2026-08-26), `maxRequestsPerMinute` was set to 2000 (33/s) but actual
   * throughput was ~3.7 calls/s — network round-trip latency (~270ms/call),
   * not the per-minute cap, was the bottleneck at concurrency 1. Projected
   * over the full ~8.9M-block backfill that's ~84 days, far past the plan's
   * ~25-37h estimate, which assumed throughput near the rate limit itself —
   * only reachable with multiple requests in flight.
   */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

async function fetchOneBlock(client: BlockmachineClient, blockNumber: number): Promise<RawBlockRecord> {
  const blockHash = await client.call<string>("chain_getBlockHash", [blockNumber]);
  if (!blockHash) {
    throw new Error(`chain_getBlockHash(${blockNumber}) returned no hash — chain hasn't reached this height yet?`);
  }
  const [eventsHex, timestampHex] = await Promise.all([
    client.call<string | null>("state_getStorage", [SYSTEM_EVENTS_KEY, blockHash]),
    client.call<string | null>("state_getStorage", [TIMESTAMP_NOW_KEY, blockHash]),
  ]);

  return {
    blockNumber,
    blockHash,
    // A block with zero events legitimately returns null (empty Vec, not
    // an error) — normalize to the SCALE-empty-vec encoding so silver's
    // decoder doesn't need a null special case.
    eventsHex: eventsHex ?? "0x00",
    timestampHex,
  };
}

/**
 * Fetches raw `System.Events` + `Timestamp.Now` for every block in
 * [fromBlock, toBlock], up to `concurrency` blocks in flight at once (the
 * client's own rate limiter still paces the underlying RPC calls — see
 * `FetchBlockRangeOptions.concurrency`). Throws on the first failure rather
 * than returning a partial array — §5 Tier 3: "the ingestion worker must
 * fail loudly, never write partial bronze" — and stops scheduling new blocks
 * once that happens, though blocks already in flight may still complete.
 *
 * Results are written into the output array by block index, not completion
 * order, so the returned array is in block order regardless of which
 * concurrent fetch finished first.
 */
export async function fetchBlockRange(opts: FetchBlockRangeOptions): Promise<RawBlockRecord[]> {
  const { client, fromBlock, toBlock, concurrency = 1, onProgress } = opts;
  if (toBlock < fromBlock) throw new Error(`toBlock (${toBlock}) must be >= fromBlock (${fromBlock})`);

  const total = toBlock - fromBlock + 1;
  const records: RawBlockRecord[] = new Array(total);
  let nextIndex = 0;
  let completed = 0;
  let stopped = false;

  async function worker(): Promise<void> {
    for (;;) {
      if (stopped) return;
      const index = nextIndex++;
      if (index >= total) return;

      try {
        records[index] = await fetchOneBlock(client, fromBlock + index);
      } catch (err) {
        stopped = true;
        throw err;
      }
      completed++;
      onProgress?.(completed, total);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return records;
}

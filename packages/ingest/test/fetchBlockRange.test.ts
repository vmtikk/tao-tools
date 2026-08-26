import { describe, expect, it } from "vitest";
import type { BlockmachineClient } from "../src/chain/rpcClient.js";
import { fetchBlockRange } from "../src/chain/fetchBlockRange.js";
import { SYSTEM_EVENTS_KEY, TIMESTAMP_NOW_KEY } from "../src/chain/storageKeys.js";

function fakeClient(handlers: {
  blockHash?: (n: number) => string | null;
  storage?: (key: string, hash: string) => string | null;
}): BlockmachineClient {
  const calls: [string, unknown[]][] = [];
  return {
    get requestCount() {
      return calls.length;
    },
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push([method, params]);
      if (method === "chain_getBlockHash") {
        const n = params[0] as number;
        return (handlers.blockHash ? handlers.blockHash(n) : `0xhash${n}`) as T;
      }
      if (method === "state_getStorage") {
        const [key, hash] = params as [string, string];
        return (handlers.storage ? handlers.storage(key, hash) : null) as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe("fetchBlockRange (contract — injected client)", () => {
  it("fetches hash, events, and timestamp for each block in the inclusive range", async () => {
    const client = fakeClient({
      storage: (key, hash) => {
        if (key === SYSTEM_EVENTS_KEY) return `0xevents-${hash}`;
        if (key === TIMESTAMP_NOW_KEY) return `0xts-${hash}`;
        throw new Error(`unexpected key ${key}`);
      },
    });

    const records = await fetchBlockRange({ client, fromBlock: 5, toBlock: 7 });

    expect(records).toEqual([
      { blockNumber: 5, blockHash: "0xhash5", eventsHex: "0xevents-0xhash5", timestampHex: "0xts-0xhash5" },
      { blockNumber: 6, blockHash: "0xhash6", eventsHex: "0xevents-0xhash6", timestampHex: "0xts-0xhash6" },
      { blockNumber: 7, blockHash: "0xhash7", eventsHex: "0xevents-0xhash7", timestampHex: "0xts-0xhash7" },
    ]);
  });

  it("normalizes a null events response (empty block) to the SCALE-empty-vec encoding", async () => {
    const client = fakeClient({ storage: () => null });
    const records = await fetchBlockRange({ client, fromBlock: 1, toBlock: 1 });
    expect(records[0]!.eventsHex).toBe("0x00");
    expect(records[0]!.timestampHex).toBeNull();
  });

  it("reports progress for every block", async () => {
    const client = fakeClient({});
    const progress: [number, number][] = [];
    await fetchBlockRange({ client, fromBlock: 1, toBlock: 3, onProgress: (done, total) => progress.push([done, total]) });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("throws rather than returning a partial array when a block hash is missing", async () => {
    const client = fakeClient({ blockHash: (n) => (n === 2 ? null : `0xhash${n}`) });
    await expect(fetchBlockRange({ client, fromBlock: 1, toBlock: 3 })).rejects.toThrow(/hasn't reached this height/);
  });

  it("rejects an inverted range", async () => {
    const client = fakeClient({});
    await expect(fetchBlockRange({ client, fromBlock: 5, toBlock: 1 })).rejects.toThrow(/toBlock/);
  });
});

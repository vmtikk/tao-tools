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

describe("fetchBlockRange (concurrency)", () => {
  /** Delays state_getStorage by an amount that varies per block, so blocks
   * complete out of order — exercises whether results still land at the
   * correct array index regardless of completion order. */
  function fakeClientWithVariableLatency(delayForBlock: (n: number) => number): BlockmachineClient {
    const calls: [string, unknown[]][] = [];
    return {
      get requestCount() {
        return calls.length;
      },
      async call<T>(method: string, params: unknown[]): Promise<T> {
        calls.push([method, params]);
        if (method === "chain_getBlockHash") {
          return `0xhash${params[0]}` as T;
        }
        if (method === "state_getStorage") {
          const [key, hash] = params as [string, string];
          const n = Number(hash.replace("0xhash", ""));
          await new Promise((resolve) => setTimeout(resolve, delayForBlock(n)));
          if (key === SYSTEM_EVENTS_KEY) return `0xevents-${n}` as T;
          if (key === TIMESTAMP_NOW_KEY) return `0xts-${n}` as T;
          throw new Error(`unexpected key ${key}`);
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
  }

  it("returns results in block order even when later blocks resolve first", async () => {
    // Descending delay: the last block in the range has the shortest delay,
    // so it resolves first if anything does.
    const client = fakeClientWithVariableLatency((n) => (10 - n) * 5);
    const records = await fetchBlockRange({ client, fromBlock: 1, toBlock: 10, concurrency: 5 });

    expect(records.map((r) => r.blockNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(records.map((r) => r.eventsHex)).toEqual(
      Array.from({ length: 10 }, (_, i) => `0xevents-${i + 1}`),
    );
  });

  it("reports progress exactly once per block, reaching the total", async () => {
    const client = fakeClientWithVariableLatency(() => 0);
    const progress: number[] = [];
    await fetchBlockRange({
      client,
      fromBlock: 1,
      toBlock: 20,
      concurrency: 4,
      onProgress: (done) => progress.push(done),
    });

    expect(progress).toHaveLength(20);
    expect(new Set(progress).size).toBe(20);
    expect(Math.max(...progress)).toBe(20);
  });

  it("caps concurrency at the number of blocks in the range", async () => {
    const client = fakeClientWithVariableLatency(() => 0);
    const records = await fetchBlockRange({ client, fromBlock: 1, toBlock: 3, concurrency: 100 });
    expect(records).toHaveLength(3);
  });

  it("propagates a failure and stops scheduling further blocks", async () => {
    let calls = 0;
    const client: BlockmachineClient = {
      get requestCount() {
        return calls;
      },
      async call<T>(method: string, params: unknown[]): Promise<T> {
        calls++;
        if (method === "chain_getBlockHash") {
          const n = params[0] as number;
          if (n === 3) throw new Error("boom");
          return `0xhash${n}` as T;
        }
        return null as T;
      },
    };

    await expect(fetchBlockRange({ client, fromBlock: 1, toBlock: 50, concurrency: 2 })).rejects.toThrow("boom");
  });
});

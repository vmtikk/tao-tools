import { describe, expect, it } from "vitest";
import type { BlockmachineClient } from "../src/chain/rpcClient.js";
import { detectRuntimeSegments } from "../src/chain/detectRuntimeUpgrades.js";

/** A fake chain whose spec_version steps up at the given block numbers
 * (inclusive of the new version). Counts calls so tests can assert the
 * binary search stays sub-linear in the range size. */
function fakeChain(upgradeBlocks: number[]): { client: BlockmachineClient; callCount: () => number } {
  let calls = 0;
  const specVersionAt = (n: number): number => {
    let version = 1;
    for (const upgradeBlock of upgradeBlocks) {
      if (n >= upgradeBlock) version++;
    }
    return version;
  };
  const client: BlockmachineClient = {
    get requestCount() {
      return calls;
    },
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls++;
      if (method === "chain_getBlockHash") return `0xhash${params[0]}` as T;
      if (method === "state_getRuntimeVersion") {
        const hash = params[0] as string;
        const n = Number(hash.replace("0xhash", ""));
        return { specVersion: specVersionAt(n) } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, callCount: () => calls };
}

describe("detectRuntimeSegments", () => {
  it("returns a single segment when there is no upgrade in range", async () => {
    const { client } = fakeChain([]);
    const segments = await detectRuntimeSegments(client, 100, 200);
    expect(segments).toEqual([{ fromBlock: 100, toBlock: 200, specVersion: 1 }]);
  });

  it("handles a single-block range", async () => {
    const { client } = fakeChain([50]);
    const segments = await detectRuntimeSegments(client, 100, 100);
    expect(segments).toEqual([{ fromBlock: 100, toBlock: 100, specVersion: 2 }]);
  });

  it("finds a single upgrade boundary inside the range", async () => {
    const { client } = fakeChain([150]);
    const segments = await detectRuntimeSegments(client, 100, 200);
    expect(segments).toEqual([
      { fromBlock: 100, toBlock: 149, specVersion: 1 },
      { fromBlock: 150, toBlock: 200, specVersion: 2 },
    ]);
  });

  it("finds an upgrade at the very first or last block of the range", async () => {
    const { client: c1 } = fakeChain([100]);
    expect(await detectRuntimeSegments(c1, 100, 200)).toEqual([{ fromBlock: 100, toBlock: 200, specVersion: 2 }]);

    const { client: c2 } = fakeChain([200]);
    expect(await detectRuntimeSegments(c2, 100, 200)).toEqual([
      { fromBlock: 100, toBlock: 199, specVersion: 1 },
      { fromBlock: 200, toBlock: 200, specVersion: 2 },
    ]);
  });

  it("finds multiple upgrades inside one range", async () => {
    const { client } = fakeChain([130, 170, 190]);
    const segments = await detectRuntimeSegments(client, 100, 200);
    expect(segments).toEqual([
      { fromBlock: 100, toBlock: 129, specVersion: 1 },
      { fromBlock: 130, toBlock: 169, specVersion: 2 },
      { fromBlock: 170, toBlock: 189, specVersion: 3 },
      { fromBlock: 190, toBlock: 200, specVersion: 4 },
    ]);
  });

  it("costs far fewer RPC calls than one probe per block", async () => {
    const { client, callCount } = fakeChain([50_000]);
    await detectRuntimeSegments(client, 1, 100_000);
    // Two specVersionAt calls per probe (hash + runtime version); a handful
    // of probes total for one upgrade in a 100k-block range, not 100k.
    expect(callCount()).toBeLessThan(200);
  });

  it("rejects an inverted range", async () => {
    const { client } = fakeChain([]);
    await expect(detectRuntimeSegments(client, 200, 100)).rejects.toThrow(/toBlock/);
  });
});

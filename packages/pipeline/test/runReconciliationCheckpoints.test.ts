import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BalanceEvent } from "@tao-tools/core";
import { asBlockNumber, asColdkey, asRao } from "@tao-tools/core";
import type { BlockmachineClient } from "@tao-tools/ingest";
import { systemAccountKey } from "@tao-tools/ingest";
import { buildRegistry } from "../src/chain/decodeEvents.js";
import { runReconciliationCheckpoints } from "../src/chain/runReconciliationCheckpoints.js";

const metadataFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "metadata-specVersion101.json"), "utf-8"),
) as { metadataHex: string };
const registry = buildRegistry(metadataFixture.metadataHex);

function encodeAccountInfo(freeRao: bigint): string {
  return registry.createType("AccountInfo", { data: { free: freeRao } }).toHex();
}

const ALICE = asColdkey("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
const BOB = asColdkey("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty");
const CHARLIE = asColdkey("5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y");

function transfer(blockNumber: number, from: string, to: string, amount: bigint): BalanceEvent {
  return {
    kind: "transfer",
    blockNumber: asBlockNumber(blockNumber),
    eventIndex: 0,
    from: asColdkey(from),
    to: asColdkey(to),
    amount: asRao(amount),
  };
}

function fakeClientForColdkeys(
  realBalancesAtBlock: Record<number, Partial<Record<string, bigint>>>,
): BlockmachineClient & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const keyToColdkey = new Map<string, string>();
  for (const coldkey of [ALICE, BOB, CHARLIE]) keyToColdkey.set(systemAccountKey(coldkey), coldkey);

  return {
    calls,
    get requestCount() {
      return calls.length;
    },
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push([method, params]);
      if (method === "chain_getBlockHash") return `0xhash${params[0]}` as T;
      if (method === "state_getRuntimeVersion") return { specVersion: 101 } as T;
      if (method === "state_getMetadata") return metadataFixture.metadataHex as T;
      if (method === "state_getStorage") {
        const [key, hash] = params as [string, string];
        const blockNumber = Number(String(hash).replace("0xhash", ""));
        const coldkey = keyToColdkey.get(key);
        const free = coldkey ? realBalancesAtBlock[blockNumber]?.[coldkey] : undefined;
        return (free === undefined ? null : encodeAccountInfo(free)) as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

describe("runReconciliationCheckpoints", () => {
  it("splits the range into non-overlapping windows and skips a partial trailing window", async () => {
    const client = fakeClientForColdkeys({});
    const checkpoints = await runReconciliationCheckpoints({
      client,
      intervalBlocks: 100,
      upToBlock: 250,
      fromBlock: 1,
      events: [],
    });

    // [1,100] and [101,200] are complete; [201,250] is a 50-block partial
    // window and must be skipped, not checked early.
    expect(checkpoints.map((c) => [c.fromBlock, c.toBlock])).toEqual([
      [1, 100],
      [101, 200],
    ]);
  });

  it("returns nothing when no complete window fits", async () => {
    const client = fakeClientForColdkeys({});
    const checkpoints = await runReconciliationCheckpoints({ client, intervalBlocks: 1000, upToBlock: 500, events: [] });
    expect(checkpoints).toEqual([]);
  });

  it("carries validated balances forward, avoiding a redundant on-chain read in the next checkpoint", async () => {
    const events: BalanceEvent[] = [
      transfer(50, ALICE, BOB, 100n), // checkpoint 1: [1,100]
      transfer(150, BOB, CHARLIE, 40n), // checkpoint 2: [101,200]
    ];
    const client = fakeClientForColdkeys({
      0: { [ALICE]: 100n }, // Alice needs funds before she can send any
      100: { [ALICE]: 0n, [BOB]: 100n }, // end of checkpoint 1
      200: { [BOB]: 60n, [CHARLIE]: 40n }, // end of checkpoint 2
    });

    const checkpoints = await runReconciliationCheckpoints({
      client,
      intervalBlocks: 100,
      upToBlock: 200,
      fromBlock: 1,
      events,
    });

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]!.mismatches).toEqual([]);
    expect(checkpoints[1]!.mismatches).toEqual([]);

    // Bob was already validated as of block 100 in checkpoint 1 — checkpoint
    // 2 must not re-fetch a fresh on-chain baseline for him at block 100.
    const bobKey = systemAccountKey(BOB);
    const bobBaselineReadsAtBlock100 = client.calls.filter(
      ([method, params]) =>
        method === "state_getStorage" && (params as [string, string])[0] === bobKey && (params as [string, string])[1] === "0xhash100",
    );
    expect(bobBaselineReadsAtBlock100).toHaveLength(1); // only checkpoint 1's own end-of-window verification read
  });

  it("surfaces a mismatch as a MISMATCH row without throwing", async () => {
    const events: BalanceEvent[] = [transfer(50, ALICE, BOB, 100n)];
    // Real chain disagrees with the fold's answer.
    const client = fakeClientForColdkeys({ 100: { [ALICE]: 999n, [BOB]: 999n } });

    const checkpoints = await runReconciliationCheckpoints({
      client,
      intervalBlocks: 100,
      upToBlock: 100,
      fromBlock: 1,
      events,
    });

    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.mismatches.length).toBeGreaterThan(0);
  });

  it("resumeFrom skips already-completed windows and reuses their carried-forward balances", async () => {
    const events: BalanceEvent[] = [
      transfer(50, ALICE, BOB, 100n), // window 1: [1,100]
      transfer(150, BOB, CHARLIE, 40n), // window 2: [101,200]
    ];
    const client = fakeClientForColdkeys({
      200: { [BOB]: 60n, [CHARLIE]: 40n },
    });

    // Simulate an earlier run having already completed window 1, carrying
    // Bob's validated balance (100) forward instead of window 1 being redone.
    const checkpoints = await runReconciliationCheckpoints({
      client,
      intervalBlocks: 100,
      upToBlock: 200,
      fromBlock: 1,
      events,
      resumeFrom: { windowStart: 101, knownGoodBalances: new Map([[BOB, asRao(100n)]]) },
    });

    // Only window 2 ran — window 1 never touched the client at all.
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ fromBlock: 101, toBlock: 200 });
    const hash0Reads = client.calls.filter(([, params]) => (params as [string, string])[1] === "0xhash0");
    expect(hash0Reads).toEqual([]); // window 1's own baseline read, at block 0, never happened
  });

  it("calls onWindowComplete once per window, after that window's own result is available", async () => {
    const events: BalanceEvent[] = [transfer(50, ALICE, BOB, 100n), transfer(150, BOB, CHARLIE, 40n)];
    const client = fakeClientForColdkeys({
      0: { [ALICE]: 100n },
      100: { [ALICE]: 0n, [BOB]: 100n },
      200: { [BOB]: 60n, [CHARLIE]: 40n },
    });

    const completed: { toBlock: number; knownGoodKeys: string[] }[] = [];
    await runReconciliationCheckpoints({
      client,
      intervalBlocks: 100,
      upToBlock: 200,
      fromBlock: 1,
      events,
      onWindowComplete: (result, knownGoodBalances) => {
        completed.push({ toBlock: result.toBlock, knownGoodKeys: [...knownGoodBalances.keys()].sort() });
      },
    });

    expect(completed.map((c) => c.toBlock)).toEqual([100, 200]);
    // After window 1, only Alice/Bob are known; after window 2, Charlie too.
    expect(completed[0]!.knownGoodKeys.sort()).toEqual([ALICE, BOB].sort());
    expect(completed[1]!.knownGoodKeys.sort()).toEqual([ALICE, BOB, CHARLIE].sort());
  });
});

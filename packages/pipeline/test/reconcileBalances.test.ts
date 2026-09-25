import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BalanceEvent } from "@tao-tools/core";
import { asBlockNumber, asColdkey, asRao } from "@tao-tools/core";
import type { BlockmachineClient } from "@tao-tools/ingest";
import { systemAccountKey } from "@tao-tools/ingest";
import { buildRegistry } from "../src/chain/decodeEvents.js";
import { reconcileBalances } from "../src/chain/reconcileBalances.js";

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

// systemAccountKey(coldkey) is deterministic (blake2/twox over the SS58
// address), so precompute the keys once per test coldkey and match on those
// rather than re-implementing the hashing in the fake client.
function fakeClientForColdkeys(
  realBalancesAtBlock: Record<number, Partial<Record<string, bigint>>>,
): BlockmachineClient & { calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const keyToColdkey = new Map<string, string>();
  for (const coldkey of [ALICE, BOB, CHARLIE]) {
    keyToColdkey.set(systemAccountKey(coldkey), coldkey);
  }

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

function transfer(blockNumber: number, eventIndex: number, from: string, to: string, amount: bigint): BalanceEvent {
  return {
    kind: "transfer",
    blockNumber: asBlockNumber(blockNumber),
    eventIndex,
    from: asColdkey(from),
    to: asColdkey(to),
    amount: asRao(amount),
  };
}

describe("reconcileBalances", () => {
  it("does not double-count events before fromBlock (the original Phase 2.2 bug for any non-genesis window)", async () => {
    // Alice -> Bob for 100 at block 50 (before the window), then Bob -> Charlie
    // for 30 at block 150 (inside the window [100, 200]).
    const events: BalanceEvent[] = [
      transfer(50, 0, ALICE, BOB, 100n),
      transfer(150, 0, BOB, CHARLIE, 30n),
    ];

    // Real chain state: at block 99 (fromBlock - 1), Bob already has 100 from
    // the pre-window transfer; at block 200, Bob has 70 and Charlie has 30.
    const client = fakeClientForColdkeys({
      99: { [BOB]: 100n },
      200: { [BOB]: 70n, [CHARLIE]: 30n },
    });

    const result = await reconcileBalances({ fromBlock: 100, toBlock: 200, client, events });

    const bobRow = result.rows.find((r) => r.coldkey === BOB)!;
    const charlieRow = result.rows.find((r) => r.coldkey === CHARLIE)!;
    // A double-counting bug would fold the block-50 transfer AGAIN on top of
    // the real 100-at-block-99 baseline, producing bob=0 (100 baseline - 100
    // re-applied - ... ) or some other wrong number, and would flag as a
    // MISMATCH. The fix folds only the block-150 event on top of the real
    // baseline: bob = 100 - 30 = 70, charlie = 0 + 30 = 30.
    expect(bobRow.reconstructedRao).toBe(70n);
    expect(bobRow.matches).toBe(true);
    expect(charlieRow.reconstructedRao).toBe(30n);
    expect(charlieRow.matches).toBe(true);
  });

  it("uses knownGoodBalances instead of fetching a fresh on-chain baseline for already-known coldkeys", async () => {
    const events: BalanceEvent[] = [transfer(150, 0, ALICE, BOB, 10n)];
    const client = fakeClientForColdkeys({ 200: { [ALICE]: 90n, [BOB]: 10n } });

    const knownGoodBalances = new Map([
      [ALICE, asRao(100n)],
      [BOB, asRao(0n)],
    ]);

    const result = await reconcileBalances({
      fromBlock: 100,
      toBlock: 200,
      client,
      events,
      knownGoodBalances,
    });

    // No state_getStorage call should have been made at the start-of-window
    // hash (block 99) for Alice or Bob, since both were already known.
    const startBlockReads = client.calls.filter(
      ([method, params]) => method === "state_getStorage" && (params as [string, string])[1] === "0xhash99",
    );
    expect(startBlockReads).toHaveLength(0);

    expect(result.rows.find((r) => r.coldkey === ALICE)!.reconstructedRao).toBe(90n);
    expect(result.rows.find((r) => r.coldkey === BOB)!.reconstructedRao).toBe(10n);
  });

  it("still fetches a fresh baseline for a coldkey newly touched in this window", async () => {
    const events: BalanceEvent[] = [transfer(150, 0, ALICE, CHARLIE, 5n)];
    const client = fakeClientForColdkeys({
      99: { [CHARLIE]: 0n },
      200: { [ALICE]: 95n, [CHARLIE]: 5n },
    });
    const knownGoodBalances = new Map([[ALICE, asRao(100n)]]);

    const result = await reconcileBalances({ fromBlock: 100, toBlock: 200, client, events, knownGoodBalances });

    const charlieBaselineRead = client.calls.filter(
      ([method, params]) => method === "state_getStorage" && (params as [string, string])[1] === "0xhash99",
    );
    expect(charlieBaselineRead.length).toBeGreaterThan(0);
    expect(result.rows.find((r) => r.coldkey === CHARLIE)!.matches).toBe(true);
  });

  it("returns a balances map covering untouched previously-known coldkeys unchanged, for carry-forward", async () => {
    const events: BalanceEvent[] = [transfer(150, 0, BOB, CHARLIE, 1n)];
    const client = fakeClientForColdkeys({ 200: { [BOB]: 9n, [CHARLIE]: 1n } });
    const knownGoodBalances = new Map([
      [ALICE, asRao(500n)], // untouched this window
      [BOB, asRao(10n)],
    ]);

    const result = await reconcileBalances({ fromBlock: 100, toBlock: 200, client, events, knownGoodBalances });

    expect(result.balances.get(ALICE)).toBe(500n); // carried through unchanged
    expect(result.balances.get(BOB)).toBe(9n);
    expect(result.balances.get(CHARLIE)).toBe(1n);
  });

  it("only reports rows for coldkeys touched in this window, not every coldkey ever known", async () => {
    const events: BalanceEvent[] = [transfer(150, 0, BOB, CHARLIE, 1n)];
    const client = fakeClientForColdkeys({ 200: { [BOB]: 9n, [CHARLIE]: 1n } });
    const knownGoodBalances = new Map([[ALICE, asRao(500n)]]);

    const result = await reconcileBalances({ fromBlock: 100, toBlock: 200, client, events, knownGoodBalances });

    expect(result.rows.map((r) => r.coldkey).sort()).toEqual([BOB, CHARLIE].sort());
    expect(result.touchedAccounts).toBe(2);
  });

  it("concurrency > 1 produces the same result as sequential, with reads actually overlapping", async () => {
    // Alice, Bob, and Charlie are all newly touched in this window, so both
    // the baseline pass and the final-balance pass have 3 coldkeys each to
    // read — enough to observe overlap at concurrency 2.
    const events: BalanceEvent[] = [
      transfer(150, 0, ALICE, BOB, 10n),
      transfer(160, 1, BOB, CHARLIE, 4n),
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const base = fakeClientForColdkeys({
      99: { [ALICE]: 100n, [BOB]: 0n, [CHARLIE]: 0n },
      200: { [ALICE]: 90n, [BOB]: 6n, [CHARLIE]: 4n },
    });
    const client: BlockmachineClient & { calls: [string, unknown[]][] } = {
      ...base,
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method !== "state_getStorage") return base.call(method, params);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await base.call<T>(method, params);
        inFlight--;
        return result;
      },
    };

    const result = await reconcileBalances({ fromBlock: 100, toBlock: 200, client, events, concurrency: 2 });

    expect(maxInFlight).toBeGreaterThan(1);
    expect(result.rows.find((r) => r.coldkey === ALICE)!.reconstructedRao).toBe(90n);
    expect(result.rows.find((r) => r.coldkey === BOB)!.reconstructedRao).toBe(6n);
    expect(result.rows.find((r) => r.coldkey === CHARLIE)!.reconstructedRao).toBe(4n);
    expect(result.rows.every((r) => r.matches)).toBe(true);
  });
});

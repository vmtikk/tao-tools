import { describe, expect, it } from "vitest";
import { applyBalanceEvent, reconstructBalances, type BalanceMap } from "../src/balances/reconstruct.js";
import { asBlockNumber, asColdkey, asRao, type Coldkey, type Rao } from "../src/types/brands.js";
import type { BalanceEvent } from "../src/types/chain.js";

const BLOCK = asBlockNumber(1);
const ALICE = asColdkey("5Alice");
const BOB = asColdkey("5Bob");
const CAROL = asColdkey("5Carol");

function transfer(from: Coldkey, to: Coldkey, amount: bigint, eventIndex: number): BalanceEvent {
  return { kind: "transfer", blockNumber: BLOCK, eventIndex, from, to, amount: asRao(amount) };
}

function deposit(coldkey: Coldkey, amount: bigint, eventIndex: number): BalanceEvent {
  return { kind: "deposit", blockNumber: BLOCK, eventIndex, coldkey, amount: asRao(amount) };
}

function withdraw(coldkey: Coldkey, amount: bigint, eventIndex: number): BalanceEvent {
  return { kind: "withdraw", blockNumber: BLOCK, eventIndex, coldkey, amount: asRao(amount) };
}

function sumOf(balances: BalanceMap): bigint {
  let total = 0n;
  for (const v of balances.values()) total += v;
  return total;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

describe("applyBalanceEvent", () => {
  it("moves rao from `from` to `to` on transfer", () => {
    const balances = new Map<Coldkey, Rao>([[ALICE, asRao(1000n)]]);
    const next = applyBalanceEvent(balances, transfer(ALICE, BOB, 300n, 0));
    expect(next.get(ALICE)).toBe(asRao(700n));
    expect(next.get(BOB)).toBe(asRao(300n));
  });

  it("credits a fresh coldkey on deposit with no prior balance", () => {
    const next = applyBalanceEvent(new Map(), deposit(ALICE, 100n, 0));
    expect(next.get(ALICE)).toBe(asRao(100n));
  });

  it("debits on withdraw, allowing a negative result rather than clamping (the reconciliation script decides what a negative means, not the fold)", () => {
    const balances = new Map<Coldkey, Rao>([[ALICE, asRao(50n)]]);
    const next = applyBalanceEvent(balances, withdraw(ALICE, 80n, 0));
    expect(next.get(ALICE)).toBe(asRao(-30n));
  });

  it("does not mutate the input map", () => {
    const balances = new Map<Coldkey, Rao>([[ALICE, asRao(1000n)]]);
    applyBalanceEvent(balances, transfer(ALICE, BOB, 300n, 0));
    expect(balances.get(ALICE)).toBe(asRao(1000n));
    expect(balances.has(BOB)).toBe(false);
  });
});

describe("reconstructBalances", () => {
  it("folds a sequence of events into a final balance map", () => {
    const result = reconstructBalances([
      deposit(ALICE, 1000n, 0),
      transfer(ALICE, BOB, 400n, 1),
      transfer(BOB, CAROL, 150n, 2),
      withdraw(CAROL, 50n, 3),
    ]);
    expect(result.get(ALICE)).toBe(asRao(600n));
    expect(result.get(BOB)).toBe(asRao(250n));
    expect(result.get(CAROL)).toBe(asRao(100n));
  });

  it("total supply is conserved across any permutation of a pure-transfer event set (§5 Tier 1 property test)", () => {
    const initial = new Map<Coldkey, Rao>([
      [ALICE, asRao(1000n)],
      [BOB, asRao(500n)],
    ]);
    const events: BalanceEvent[] = [
      transfer(ALICE, BOB, 300n, 0),
      transfer(BOB, CAROL, 200n, 1),
      transfer(CAROL, ALICE, 50n, 2),
      transfer(ALICE, CAROL, 120n, 3),
    ];
    const expectedSupply = sumOf(initial);

    for (const order of permutations(events)) {
      const result = reconstructBalances(order, initial);
      expect(sumOf(result)).toBe(expectedSupply);
    }
  });

  it("the final balance map itself is order-independent for pure transfers, not just its total (the fold has no order-sensitive clamping)", () => {
    const initial = new Map<Coldkey, Rao>([
      [ALICE, asRao(1000n)],
      [BOB, asRao(500n)],
    ]);
    const events: BalanceEvent[] = [
      transfer(ALICE, BOB, 300n, 0),
      transfer(BOB, CAROL, 200n, 1),
      transfer(CAROL, ALICE, 50n, 2),
    ];

    const results = permutations(events).map((order) => reconstructBalances(order, initial));
    const first = results[0]!;
    for (const result of results.slice(1)) {
      expect(result.get(ALICE)).toBe(first.get(ALICE));
      expect(result.get(BOB)).toBe(first.get(BOB));
      expect(result.get(CAROL)).toBe(first.get(CAROL));
    }
  });

  it("deposits and withdrawals change total supply by exactly their net amount, in any order", () => {
    const events: BalanceEvent[] = [deposit(ALICE, 1000n, 0), withdraw(ALICE, 300n, 1), deposit(BOB, 50n, 2)];
    for (const order of permutations(events)) {
      const result = reconstructBalances(order);
      expect(sumOf(result)).toBe(750n);
    }
  });
});

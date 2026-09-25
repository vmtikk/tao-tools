import { describe, expect, it } from "vitest";
import { normalizeBalanceEvent, normalizeStakeEvent } from "../src/events/normalize.js";
import { asBlockNumber, asColdkey, asHotkey, asRao } from "../src/types/brands.js";

const BLOCK = asBlockNumber(42);

describe("normalizeBalanceEvent", () => {
  it("normalizes a Transfer", () => {
    const result = normalizeBalanceEvent(
      { section: "balances", method: "Transfer", data: ["5Alice", "5Bob", 1_000_000_000n] },
      BLOCK,
      0,
    );
    expect(result).toEqual({
      kind: "transfer",
      blockNumber: BLOCK,
      eventIndex: 0,
      from: asColdkey("5Alice"),
      to: asColdkey("5Bob"),
      amount: asRao(1_000_000_000n),
    });
  });

  it("normalizes a Deposit", () => {
    const result = normalizeBalanceEvent(
      { section: "balances", method: "Deposit", data: ["5Alice", 500n] },
      BLOCK,
      1,
    );
    expect(result).toEqual({
      kind: "deposit",
      blockNumber: BLOCK,
      eventIndex: 1,
      coldkey: asColdkey("5Alice"),
      amount: asRao(500n),
    });
  });

  it("normalizes a Withdraw", () => {
    const result = normalizeBalanceEvent(
      { section: "balances", method: "Withdraw", data: ["5Alice", 250n] },
      BLOCK,
      2,
    );
    expect(result).toEqual({
      kind: "withdraw",
      blockNumber: BLOCK,
      eventIndex: 2,
      coldkey: asColdkey("5Alice"),
      amount: asRao(250n),
    });
  });

  it("normalizes a DustLost as a withdraw (the runtime reaping an account below the existential deposit)", () => {
    const result = normalizeBalanceEvent(
      { section: "balances", method: "DustLost", data: ["5Alice", 1n] },
      BLOCK,
      3,
    );
    expect(result).toEqual({
      kind: "withdraw",
      blockNumber: BLOCK,
      eventIndex: 3,
      coldkey: asColdkey("5Alice"),
      amount: asRao(1n),
    });
  });

  it("returns null for a non-balances section", () => {
    expect(normalizeBalanceEvent({ section: "system", method: "ExtrinsicSuccess", data: [] }, BLOCK, 0)).toBeNull();
  });

  it("returns null for an unhandled balances method", () => {
    expect(
      normalizeBalanceEvent({ section: "balances", method: "Reserved", data: ["5Alice", 1n] }, BLOCK, 0),
    ).toBeNull();
  });
});

describe("normalizeStakeEvent", () => {
  it("normalizes a pre-dTAO StakeAdded (hotkey, amount)", () => {
    const result = normalizeStakeEvent(
      { section: "subtensormodule", method: "StakeAdded", data: ["5Hotkey", 999_999_000n] },
      BLOCK,
      0,
    );
    expect(result).toEqual({
      kind: "stakeAdded",
      blockNumber: BLOCK,
      eventIndex: 0,
      hotkey: asHotkey("5Hotkey"),
      amount: asRao(999_999_000n),
    });
  });

  it("normalizes a pre-dTAO StakeRemoved (hotkey, amount)", () => {
    const result = normalizeStakeEvent(
      { section: "subtensormodule", method: "StakeRemoved", data: ["5Hotkey", 11_999_998_100n] },
      BLOCK,
      1,
    );
    expect(result).toEqual({
      kind: "stakeRemoved",
      blockNumber: BLOCK,
      eventIndex: 1,
      hotkey: asHotkey("5Hotkey"),
      amount: asRao(11_999_998_100n),
    });
  });

  it("returns null for a non-subtensorModule section", () => {
    expect(
      normalizeStakeEvent({ section: "balances", method: "StakeAdded", data: ["5Hotkey", 1n] }, BLOCK, 0),
    ).toBeNull();
  });

  it("returns null for an unhandled subtensorModule method", () => {
    expect(
      normalizeStakeEvent({ section: "subtensormodule", method: "WeightsSet", data: [3, 25] }, BLOCK, 0),
    ).toBeNull();
  });
});

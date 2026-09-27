import { describe, expect, it } from "vitest";
import { palletIdOf } from "../src/chain/palletAccount.js";

// Real mainnet addresses from silver.transfers (June 2026).
const SUBTENSOR_MAIN = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"; // "modl" ++ "subtensr", sub-account 0
const SUBTENSOR_SUBNET_97 = "5EYCAe5jLQhn6ofDSwHa4JN7ucQgnSmZLMAzchJya5D4zq8v"; // sub-account 0x61
const ORDINARY = "5DaVTUeVE2uHcVJrw25zprundjWmh1csd1j61BjUaogEYarr";
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("palletIdOf", () => {
  it("recognizes the main subtensor pallet account", () => {
    expect(palletIdOf(SUBTENSOR_MAIN)).toBe("subtensr");
  });

  it("recognizes a per-subnet subtensor sub-account", () => {
    expect(palletIdOf(SUBTENSOR_SUBNET_97)).toBe("subtensr");
  });

  it("returns null for ordinary accounts", () => {
    expect(palletIdOf(ORDINARY)).toBeNull();
    expect(palletIdOf(ALICE)).toBeNull();
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(palletIdOf("")).toBeNull();
    expect(palletIdOf("not-base58-0OIl")).toBeNull();
    expect(palletIdOf("5Alice")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { xxhashAsHex, blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";
import {
  SYSTEM_ACCOUNT_PREFIX,
  SYSTEM_EVENTS_KEY,
  TIMESTAMP_NOW_KEY,
  coldkeyFromSystemAccountKey,
  systemAccountKey,
} from "../src/chain/storageKeys.js";

/**
 * These constants are hand-transcribed from a one-off derivation script
 * (tao-analytics-plan.md §5 Tier 3 spirit: don't trust a hex literal you
 * typed once). This test recomputes them independently at runtime and
 * fails loudly if a transcription slipped — which it did once already
 * (TIMESTAMP_NOW_KEY was one hex character short before this test existed).
 */
describe("chain storage key constants", () => {
  it("SYSTEM_EVENTS_KEY == twox128('System') ++ twox128('Events')", () => {
    const expected = "0x" + xxhashAsHex("System", 128).slice(2) + xxhashAsHex("Events", 128).slice(2);
    expect(SYSTEM_EVENTS_KEY).toBe(expected);
    expect(SYSTEM_EVENTS_KEY).toHaveLength(66);
  });

  it("TIMESTAMP_NOW_KEY == twox128('Timestamp') ++ twox128('Now')", () => {
    const expected = "0x" + xxhashAsHex("Timestamp", 128).slice(2) + xxhashAsHex("Now", 128).slice(2);
    expect(TIMESTAMP_NOW_KEY).toBe(expected);
    expect(TIMESTAMP_NOW_KEY).toHaveLength(66);
  });

  it("systemAccountKey == twox128('System') ++ twox128('Account') ++ blake2_128(accountId) ++ accountId", () => {
    // Well-known dev address ("Alice"), stable across substrate chains.
    const alice = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const accountId = decodeAddress(alice);
    const prefix = "0x" + xxhashAsHex("System", 128).slice(2) + xxhashAsHex("Account", 128).slice(2);
    const hash = Buffer.from(blake2AsU8a(accountId, 128)).toString("hex");
    const idHex = Buffer.from(accountId).toString("hex");
    const expected = prefix + hash + idHex;

    expect(systemAccountKey(alice)).toBe(expected);
    // prefix (32 bytes) + blake2_128 (16 bytes) + AccountId32 (32 bytes) = 80 bytes = 160 hex chars + "0x"
    expect(systemAccountKey(alice)).toHaveLength(162);
  });

  it("SYSTEM_ACCOUNT_PREFIX == twox128('System') ++ twox128('Account')", () => {
    expect(SYSTEM_ACCOUNT_PREFIX).toBe("0x" + xxhashAsHex("System", 128).slice(2) + xxhashAsHex("Account", 128).slice(2));
  });

  it("coldkeyFromSystemAccountKey inverts systemAccountKey", () => {
    for (const coldkey of ["5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F"]) {
      expect(coldkeyFromSystemAccountKey(systemAccountKey(coldkey))).toBe(coldkey);
    }
    expect(() => coldkeyFromSystemAccountKey(SYSTEM_ACCOUNT_PREFIX)).toThrow(/Not a System.Account key/);
  });
});

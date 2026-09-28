import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hexToU8a } from "@polkadot/util";
import { buildRegistry } from "../src/chain/decodeEvents.js";
import { decodeAccountBalances } from "../src/chain/decodeAccount.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", name), "utf-8"));

describe("decodeAccountBalances (contract — recorded real metadata)", () => {
  it("returns zeros for a null storage read (untouched account, System.Account's Default modifier)", () => {
    const registry = buildRegistry(fixture("metadata-specVersion101.json").metadataHex);
    expect(decodeAccountBalances(registry, null)).toEqual({ free: 0n, reserved: 0n });
  });

  it("decodes the all-zero fallback AccountInfo to zeros", () => {
    const registry = buildRegistry(fixture("metadata-specVersion101.json").metadataHex);
    const zeroAccountInfo = `0x${"00".repeat(48)}`;
    expect(decodeAccountBalances(registry, zeroAccountInfo)).toEqual({ free: 0n, reserved: 0n });
  });

  /**
   * Real mainnet System.Account entry (coldkey 5HeQuPV..., block 1,944,000,
   * spec_version 140) with 1 TAO reserved. The built-in `AccountInfo` read
   * this as free = 53,156,294,875 + 1e9 * 2^64 during the first full
   * reconciliation run.
   */
  it("decodes free and reserved separately for a real account holding a reserve", () => {
    const account = fixture("account-with-reserve-block-1944000.json");
    const registry = buildRegistry(fixture("metadata-specVersion140.json").metadataHex);

    expect(decodeAccountBalances(registry, account.accountInfoHex)).toEqual({
      free: 53_156_294_875n,
      reserved: 1_000_000_000n,
    });
  });

  it("the fixture really exercises the bug: polkadot.js's built-in AccountInfo misreads it", () => {
    const account = fixture("account-with-reserve-block-1944000.json");
    const registry = buildRegistry(fixture("metadata-specVersion140.json").metadataHex);
    const builtIn = registry.createType("AccountInfo", hexToU8a(account.accountInfoHex)) as unknown as {
      data: { free: { toBigInt(): bigint } };
    };
    expect(builtIn.data.free.toBigInt()).toBe(53_156_294_875n + 1_000_000_000n * 2n ** 64n);
  });
});

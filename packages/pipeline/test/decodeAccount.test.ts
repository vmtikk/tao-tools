import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRegistry } from "../src/chain/decodeEvents.js";
import { decodeFreeBalance } from "../src/chain/decodeAccount.js";

describe("decodeFreeBalance (contract — recorded real metadata)", () => {
  const metadataFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "metadata-specVersion101.json"), "utf-8"),
  ) as { metadataHex: string };

  it("returns 0n for a null storage read (untouched account, System.Account's Default modifier)", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    expect(decodeFreeBalance(registry, null)).toBe(0n);
  });

  it("decodes the all-zero fallback AccountInfo to a free balance of 0n", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    const zeroAccountInfo =
      "0x000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    expect(decodeFreeBalance(registry, zeroAccountInfo)).toBe(0n);
  });
});

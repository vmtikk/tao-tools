import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asHotkey, asRao } from "@tao-tools/core";
import { buildRegistry, decodeBalanceEventsForBlock, decodeChainEventsForBlock, decodeTimestamp } from "../src/chain/decodeEvents.js";

/**
 * Tier 3 (tao-analytics-plan.md §5): recorded real Blockmachine responses
 * (blocks 1 and 999, mainnet, captured 2026-08-26 — see fixtures/chain/),
 * replayed offline. This is what caught a real bug during development:
 * `registry.createType('u64', hexString)` silently interprets a hex *string*
 * as a numeric literal to construct rather than SCALE bytes to decode,
 * returning a wildly wrong timestamp instead of throwing — a fixture-based
 * regression test is the only thing that would have caught that reliably.
 *
 * Transfer/Deposit/Withdraw field extraction itself is unit-tested in
 * `packages/core/test/normalize.test.ts` against already-decoded plain data;
 * this file covers the SCALE-decode integration those tests deliberately
 * skip (real metadata, real bytes, real `@polkadot/types` codecs).
 */
describe("decodeEvents (contract — recorded real Blockmachine responses)", () => {
  const metadataFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "metadata-specVersion101.json"), "utf-8"),
  ) as { specVersion: number; blockHash: string; metadataHex: string };
  const blocksFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "blocks-1-and-999.json"), "utf-8"),
  ) as {
    block1: { blockNumber: number; eventsHex: string; timestampHex: string };
    block999: { blockNumber: number; eventsHex: string; timestampHex: string };
  };

  it("decodes block 1 (genesis) to zero balance events without throwing", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    const events = decodeBalanceEventsForBlock(registry, blocksFixture.block1.eventsHex, blocksFixture.block1.blockNumber);
    expect(events).toEqual([]);
  });

  it("decodes block 1's real timestamp correctly (regression guard for the hex-string-vs-bytes bug)", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    const ts = decodeTimestamp(registry, blocksFixture.block1.timestampHex);
    // 2023-03-20T18:48:00.009Z — verified independently by hand-decoding the
    // raw little-endian bytes outside @polkadot/types entirely.
    expect(ts).toBe(1679338080009);
  });

  it("decodes a real block with 17 non-balances events to zero balance events (correctly filtered, not silently broken)", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    const events = decodeBalanceEventsForBlock(registry, blocksFixture.block999.eventsHex, blocksFixture.block999.blockNumber);
    expect(events).toEqual([]);
  });

  it("treats the bronze null-events sentinel (0x00) as zero events", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    expect(decodeBalanceEventsForBlock(registry, "0x00", 1)).toEqual([]);
  });

  it("decodeTimestamp returns null for a null storage read", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    expect(decodeTimestamp(registry, null)).toBeNull();
  });
});

/**
 * Real pre-dTAO StakeAdded/StakeRemoved events (mainnet blocks 90 and 795,
 * spec_version 101, captured 2026-08-27 from bronze already in R2 — see
 * fixtures/chain/blocks-stake-events.json). No live RPC needed to record
 * these: bronze already holds every block's full System.Events blob
 * unparsed (§10), so pulling a real fixture is a local/R2 read, not a
 * Blockmachine call.
 */
describe("decodeChainEventsForBlock — stake events (contract — recorded real Blockmachine responses)", () => {
  const metadataFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "metadata-specVersion101.json"), "utf-8"),
  ) as { metadataHex: string };
  const stakeFixture = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "blocks-stake-events.json"), "utf-8"),
  ) as {
    block90StakeAdded: { blockNumber: number; eventsHex: string };
    block795StakeRemoved: { blockNumber: number; eventsHex: string };
  };

  it("decodes a real StakeAdded event, keyed by hotkey", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    const { stakeEvents } = decodeChainEventsForBlock(
      registry,
      stakeFixture.block90StakeAdded.eventsHex,
      stakeFixture.block90StakeAdded.blockNumber,
    );
    expect(stakeEvents).toEqual([
      {
        kind: "stakeAdded",
        blockNumber: 90,
        eventIndex: expect.any(Number),
        hotkey: asHotkey("5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3"),
        amount: asRao(999_999_000n),
      },
    ]);
  });

  it("decodes a real StakeRemoved event, keyed by hotkey", () => {
    const registry = buildRegistry(metadataFixture.metadataHex);
    const { stakeEvents } = decodeChainEventsForBlock(
      registry,
      stakeFixture.block795StakeRemoved.eventsHex,
      stakeFixture.block795StakeRemoved.blockNumber,
    );
    expect(stakeEvents).toEqual([
      {
        kind: "stakeRemoved",
        blockNumber: 795,
        eventIndex: expect.any(Number),
        hotkey: asHotkey("5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3"),
        amount: asRao(11_999_998_100n),
      },
    ]);
  });
});

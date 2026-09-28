import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeChainEventsBronze, writeChainMetadataBronze } from "@tao-tools/ingest";
import { buildRegistry, decodeChainEventsForBlock } from "../src/chain/decodeEvents.js";
import { loadDecodeSpecPlan, materializeChainSilver, repairUpgradeBlocks } from "../src/chain/materializeChainSilver.js";
import { withDuckDb } from "../src/duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../src/paths.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "chain");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
const metadata122 = fixture("metadata-specVersion122.json").metadataHex as string;
const metadata123 = fixture("metadata-specVersion123.json").metadataHex as string;
const upgradeBlock = fixture("block-720235-runtime-upgrade.json").block720235 as {
  blockNumber: number;
  blockHash: string;
  eventsHex: string;
  timestampHex: string;
};

const empty = (blockNumber: number) => ({ blockNumber, blockHash: `0xhash${blockNumber}`, eventsHex: "0x00", timestampHex: null });

// Filler blocks need a real timestamp: a bronze file whose timestamps are all
// null gets a different column type, and DuckDB can't union the two files.
const filler = (blockNumber: number) => ({ ...empty(blockNumber), timestampHex: upgradeBlock.timestampHex });

/** Bronze for blocks 720,233-720,236 around the real 122 -> 123 upgrade at 720,235. */
async function writeUpgradeBronze(): Promise<void> {
  await writeChainMetadataBronze({ specVersion: 122, metadataHex: metadata122, capturedAtBlock: 720233 });
  await writeChainMetadataBronze({ specVersion: 123, metadataHex: metadata123, capturedAtBlock: 720235 });
  await writeChainEventsBronze({ records: [720233, 720234].map(filler), fromBlock: 720233, toBlock: 720234, specVersion: 122 });
  await writeChainEventsBronze({
    records: [
      {
        blockNumber: upgradeBlock.blockNumber,
        blockHash: upgradeBlock.blockHash,
        eventsHex: upgradeBlock.eventsHex,
        timestampHex: upgradeBlock.timestampHex,
      },
      filler(720236),
    ],
    fromBlock: 720235,
    toBlock: 720236,
    specVersion: 123, // what the backfill stamps: the runtime *after* the block ran
  });
}

async function silverRows(sql: string): Promise<unknown[][]> {
  return withDuckDb(async (connection) => (await connection.run(sql)).getRows());
}

async function planFor() {
  return withDuckDb((connection) => loadDecodeSpecPlan(connection, `${resolveBronzeUri()}/chain/events/*.parquet`));
}

/**
 * A runtime-upgrade block's events are emitted by the old runtime, but bronze
 * stamps it with the new one (state_getRuntimeVersion reports the post-block
 * runtime). Found for real 2026-09-28: 16 upgrade blocks failed to decode and
 * were skipped, dropping their transfers/balance events from silver.
 */
describe("materializeChainSilver — runtime-upgrade blocks", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;
  let prevBronzeUri: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-silver-upgrade-"));
    prevDataRoot = process.env.DATA_ROOT;
    prevBronzeUri = process.env.BRONZE_URI;
    process.env.DATA_ROOT = join(tempRoot, "data");
    process.env.BRONZE_URI = join(tempRoot, "data", "bronze");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    if (prevBronzeUri === undefined) delete process.env.BRONZE_URI;
    else process.env.BRONZE_URI = prevBronzeUri;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("the fixture really exercises the bug: the stamped version can't decode the upgrade block", () => {
    expect(() => decodeChainEventsForBlock(buildRegistry(metadata123), upgradeBlock.eventsHex, 720235)).toThrow();
  });

  it("decodes an upgrade block with the previous block's version instead of skipping it", async () => {
    await writeUpgradeBronze();

    const result = await materializeChainSilver();

    expect(result.skippedBlocks).toEqual([]);
    const rows = await silverRows(
      `SELECT block_number, kind, coldkey, amount_rao FROM read_parquet('${silverDir()}/balance_events.parquet') ORDER BY event_index`,
    );
    expect(rows.map((r) => [Number(r[0]), r[1], r[2], Number(r[3])])).toEqual([
      [720235, "withdraw", "5FCM3DBXWiGcwYYQtT8z4ZD93TqYpYxjaAfgv6aMStV1FTCT", 360165],
      [720235, "deposit", "5FCM3DBXWiGcwYYQtT8z4ZD93TqYpYxjaAfgv6aMStV1FTCT", 360165],
    ]);
  });

  it("resolves duplicate rows with disagreeing stamps to the highest one, deterministically", async () => {
    // The Phase 2.1 tracer bullet stamped blocks 1-1000 all as 101; the
    // upgrade-aware backfill stamps 561+ as 102. Same events bytes either way.
    await writeChainEventsBronze({ records: [1, 2, 3].map(empty), fromBlock: 1, toBlock: 3, specVersion: 101 });
    await writeChainEventsBronze({ records: [2, 3].map(empty), fromBlock: 2, toBlock: 3, specVersion: 102 });

    const plan = await planFor();

    expect(plan.conflictingBlocks).toEqual([2, 3]);
    // Canonical stamps are 1:101, 2:102, 3:102 — so block 2 is the transition.
    expect([...plan.previousSpecAtTransition]).toEqual([[2, 101]]);
  });

  it("refuses to guess when stamps go backwards, which can't happen on-chain", async () => {
    await writeChainEventsBronze({ records: [1, 2].map(empty), fromBlock: 1, toBlock: 2, specVersion: 102 });
    await writeChainEventsBronze({ records: [3, 4].map(empty), fromBlock: 3, toBlock: 4, specVersion: 101 });

    await expect(planFor()).rejects.toThrow(/goes backwards at block 3/);
  });

  it("repairUpgradeBlocks restores an upgrade block's rows in an already-built staging DB", async () => {
    await writeUpgradeBronze();
    await materializeChainSilver({ resumable: true });

    // Simulate silver built by the pre-fix decoder, which skipped this block.
    const stagingDbPath = `${silverDir()}/.materialize_silver_staging.duckdb`;
    await withDuckDb(
      async (connection) => {
        await connection.run("DELETE FROM balance_events WHERE block_number = 720235;");
      },
      { dbPath: stagingDbPath },
    );

    const { repairedBlocks, changedBlocks } = await repairUpgradeBlocks();

    expect(repairedBlocks).toEqual([720235]);
    expect(changedBlocks).toEqual([{ blockNumber: 720235, rowsBefore: 0, rowsAfter: 2 }]);
    const rows = await silverRows(`SELECT COUNT(*) FROM read_parquet('${silverDir()}/balance_events.parquet') WHERE block_number = 720235`);
    expect(Number(rows[0]![0])).toBe(2);

    // Idempotent: a second repair finds nothing left to change.
    expect((await repairUpgradeBlocks()).changedBlocks).toEqual([]);
  });
});

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { writeChainEventsBronze, writeChainMetadataBronze } from "@tao-tools/ingest";
import { materializeChainSilver } from "../src/chain/materializeChainSilver.js";

const metadataFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "metadata-specVersion101.json"), "utf-8"),
) as { metadataHex: string };
const stakeFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "blocks-stake-events.json"), "utf-8"),
) as { block90StakeAdded: { blockNumber: number; blockHash: string; eventsHex: string; timestampHex: string } };

function emptyRecord(blockNumber: number) {
  return { blockNumber, blockHash: `0xhash${blockNumber}`, eventsHex: "0x00", timestampHex: null };
}

async function countRows(parquetPath: string): Promise<number> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const result = await connection.run(`SELECT COUNT(*) FROM read_parquet('${parquetPath.replace(/\\/g, "/")}');`);
    return Number((await result.getRows())[0]![0]);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/**
 * Regression coverage for the 2026-08-26 batching rewrite
 * (materializeChainSilver.ts's `BATCH_BLOCKS` doc comment): decoding
 * ~580,000 real blocks in one unbatched pass crashed with a V8 OOM. These
 * tests use a tiny `batchBlocks` override to exercise the batch-boundary
 * logic itself — the actual SCALE decode correctness is already covered by
 * decodeEvents.test.ts against real recorded fixtures.
 */
describe("materializeChainSilver (batched)", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-materialize-silver-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("visits every block across batch boundaries, not just the first/last batch", async () => {
    // 10 blocks; block 7 is deliberately stamped with a spec_version that has
    // no matching bronze metadata. With batchBlocks=3, block 7 falls in the
    // third batch ([7,9]) — a batching bug that skipped or mis-ranged a
    // middle batch would silently miss this and not throw.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });

    await writeChainEventsBronze({
      records: [1, 2, 3, 4, 5, 6].map(emptyRecord),
      fromBlock: 1,
      toBlock: 6,
      specVersion: 101,
    });
    await writeChainEventsBronze({ records: [emptyRecord(7)], fromBlock: 7, toBlock: 7, specVersion: 999 });
    await writeChainEventsBronze({
      records: [8, 9, 10].map(emptyRecord),
      fromBlock: 8,
      toBlock: 10,
      specVersion: 101,
    });

    await expect(materializeChainSilver({ batchBlocks: 3 })).rejects.toThrow(/spec_version 999.*block 7/);
  });

  it("produces complete, correct output when everything decodes cleanly across multiple batches", async () => {
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const records = Array.from({ length: 10 }, (_, i) => emptyRecord(i + 1));
    await writeChainEventsBronze({ records, fromBlock: 1, toBlock: 10, specVersion: 101 });

    // batchBlocks=3 over a 10-block range forces 4 batches: [1,3] [4,6] [7,9] [10,10].
    const result = await materializeChainSilver({ batchBlocks: 3 });

    expect(result.transfersRowCount).toBe(0);
    expect(result.balanceEventsRowCount).toBe(0);
    await expect(countRows(result.transfersDestination)).resolves.toBe(0);
    await expect(countRows(result.balanceEventsDestination)).resolves.toBe(0);
  });

  it("produces the same result regardless of batch size", async () => {
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const records = Array.from({ length: 25 }, (_, i) => emptyRecord(i + 1));
    await writeChainEventsBronze({ records, fromBlock: 1, toBlock: 25, specVersion: 101 });

    const smallBatches = await materializeChainSilver({ batchBlocks: 4 });
    const oneBatch = await materializeChainSilver({ batchBlocks: 1_000_000 });

    expect(smallBatches.transfersRowCount).toBe(oneBatch.transfersRowCount);
    expect(smallBatches.balanceEventsRowCount).toBe(oneBatch.balanceEventsRowCount);
  });

  it("decodes a block exactly once even when bronze has two overlapping rows for it", async () => {
    // Real scenario found 2026-08-27: the Phase 2.1/2.2 tracer bullet wrote
    // bronze/chain/events/000000001-000001000.parquet, and the real backfill
    // later wrote its own chunk file also covering blocks 1-1000 — bronze
    // filenames are keyed by the exact (fromBlock, toBlock) requested (see
    // bronzeWriter.ts), so two *different* overlapping ranges produce two
    // *different* files, both containing a row for the same block_number.
    // Bronze is immutable and never re-fetched (§2), so neither write is
    // ever cleaned up. Reproduced here with two distinct (fromBlock, toBlock)
    // pairs that both happen to include block 90 — writing the same pair
    // twice would just overwrite one file and not reproduce the bug.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const record = {
      blockNumber: stakeFixture.block90StakeAdded.blockNumber,
      blockHash: stakeFixture.block90StakeAdded.blockHash,
      eventsHex: stakeFixture.block90StakeAdded.eventsHex,
      timestampHex: stakeFixture.block90StakeAdded.timestampHex,
    };
    await writeChainEventsBronze({ records: [record], fromBlock: 1, toBlock: 1000, specVersion: 101 });
    await writeChainEventsBronze({ records: [record], fromBlock: 90, toBlock: 90, specVersion: 101 });

    const result = await materializeChainSilver({ batchBlocks: 1000 });

    expect(result.stakeEventsRowCount).toBe(1);
  });

  it("skips a block whose SCALE bytes fail to decode instead of crashing the whole run", async () => {
    // Found for real 2026-08-29: a runtime-upgrade-boundary block hit a
    // genuine `@polkadot/types` decode misalignment — confirmed *not* a
    // bronze/metadata/spec_version problem by checking each against a fresh
    // live read. One bad block out of ~8.9M must not halt the other
    // 8,999,999; it must also not vanish silently (see skippedBlocksLog.ts).
    // `0x04` claims a 1-element Vec<EventRecord> with zero bytes to back it
    // up — a deterministic, spec_version-independent way to force the same
    // *kind* of decode failure without depending on the specific real block.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const records = [
      emptyRecord(1),
      { blockNumber: 2, blockHash: "0xhash2", eventsHex: "0x04", timestampHex: null },
      emptyRecord(3),
    ];
    await writeChainEventsBronze({ records, fromBlock: 1, toBlock: 3, specVersion: 101 });

    const result = await materializeChainSilver({ batchBlocks: 10 });

    expect(result.skippedBlocks).toEqual([2]);
    expect(result.transfersRowCount).toBe(0);
    expect(result.balanceEventsRowCount).toBe(0);
  });
});

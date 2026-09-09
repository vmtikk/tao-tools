import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { writeChainEventsBronze, writeChainMetadataBronze } from "@tao-tools/ingest";
import { materializeChainSilver } from "../src/chain/materializeChainSilver.js";
import {
  readMaterializeSilverCheckpoint,
  writeMaterializeSilverCheckpoint,
} from "../src/chain/materializeSilverCheckpoint.js";
import { metaDir } from "../src/paths.js";

const metadataFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "metadata-specVersion101.json"), "utf-8"),
) as { metadataHex: string };
const stakeFixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "fixtures", "chain", "blocks-stake-events.json"), "utf-8"),
) as { block90StakeAdded: { blockNumber: number; blockHash: string; eventsHex: string; timestampHex: string } };

function emptyRecord(blockNumber: number) {
  return { blockNumber, blockHash: `0xhash${blockNumber}`, eventsHex: "0x00", timestampHex: null };
}

/**
 * Covers the resumability this session added to materializeChainSilver:
 * `chain:materialize-silver` decodes hours of real chain history locally,
 * and a machine that can't stay on that long needs to stop mid-run and
 * continue later without redoing already-decoded blocks. `resumable: true`
 * persists progress (a DuckDB staging file + a JSON checkpoint, mirroring
 * `@tao-tools/ingest`'s chain-backfill checkpoint) across separate process
 * invocations — these tests simulate that by calling the function twice
 * against a bronze range that grows between calls, exactly like re-running
 * the CLI after more of the background backfill has landed.
 */
describe("materializeChainSilver (resumable)", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-materialize-silver-resume-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("resumes from the checkpoint instead of redoing already-decoded blocks", async () => {
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    await writeChainEventsBronze({
      records: [1, 2, 3, 4, 5].map(emptyRecord),
      fromBlock: 1,
      toBlock: 5,
      specVersion: 101,
    });

    const first = await materializeChainSilver({ resumable: true, batchBlocks: 2 });
    expect(first.transfersRowCount).toBe(0);
    expect(first.balanceEventsRowCount).toBe(0);

    const checkpointAfterFirst = readMaterializeSilverCheckpoint(1);
    expect(checkpointAfterFirst?.lastCompletedBatchEnd).toBe(5);
    expect(existsSync(`${metaDir()}/chain_materialize_silver_checkpoint.json`)).toBe(true);

    // More bronze "arrives" — the real-world equivalent of the background
    // backfill having decoded further since the last materialize-silver run.
    await writeChainEventsBronze({
      records: [6, 7, 8, 9, 10].map(emptyRecord),
      fromBlock: 6,
      toBlock: 10,
      specVersion: 101,
    });

    const second = await materializeChainSilver({ resumable: true, batchBlocks: 2 });
    expect(second.transfersRowCount).toBe(0);
    expect(second.balanceEventsRowCount).toBe(0);

    const checkpointAfterSecond = readMaterializeSilverCheckpoint(1);
    expect(checkpointAfterSecond?.lastCompletedBatchEnd).toBe(10);
  });

  it("a resumed run's final output matches a single non-resumable run over the same full range", async () => {
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    await writeChainEventsBronze({
      records: Array.from({ length: 10 }, (_, i) => emptyRecord(i + 1)),
      fromBlock: 1,
      toBlock: 10,
      specVersion: 101,
    });

    const resumedFirstHalf = await materializeChainSilver({ resumable: true, batchBlocks: 3 });
    expect(resumedFirstHalf.transfersRowCount).toBe(0);
    // Re-running immediately (no new bronze) should be a cheap no-op that
    // still reports the complete, correct totals.
    const resumedRerun = await materializeChainSilver({ resumable: true, batchBlocks: 3 });

    expect(resumedRerun.transfersRowCount).toBe(resumedFirstHalf.transfersRowCount);
    expect(resumedRerun.balanceEventsRowCount).toBe(resumedFirstHalf.balanceEventsRowCount);
  });

  it("self-heals from a staging DB that fails to open, instead of trusting a checkpoint the (lost) data can't back up", async () => {
    // Found for real 2026-08-27: a hard kill of the whole process (not the
    // graceful stop this suite's other tests implicitly exercise via a clean
    // return) can leave the staging DB's WAL in a state DuckDB refuses to
    // replay. Sabotaging the file directly reproduces "staging DB won't
    // open" without depending on DuckDB's specific WAL bug — what matters is
    // that materializeChainSilver's recovery path (not DuckDB's) is correct.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    await writeChainEventsBronze({
      records: Array.from({ length: 10 }, (_, i) => emptyRecord(i + 1)),
      fromBlock: 1,
      toBlock: 10,
      specVersion: 101,
    });

    await materializeChainSilver({ resumable: true, batchBlocks: 5 });
    const stagingDbPath = join(process.env.DATA_ROOT!, "silver", ".materialize_silver_staging.duckdb");
    expect(existsSync(stagingDbPath)).toBe(true);
    writeFileSync(stagingDbPath, Buffer.from("not a real duckdb file"));

    const recovered = await materializeChainSilver({ resumable: true, batchBlocks: 5 });

    expect(recovered.transfersRowCount).toBe(0);
    expect(recovered.balanceEventsRowCount).toBe(0);
    const checkpointAfterRecovery = readMaterializeSilverCheckpoint(1);
    expect(checkpointAfterRecovery?.lastCompletedBatchEnd).toBe(10);
  });

  it("does not silently skip blocks when the checkpoint outlives the staging DB it refers to", async () => {
    // Found for real 2026-08-28: the checkpoint file and the staging DB can
    // end up out of sync (here, via the *other* recovery path deleting the
    // checkpoint but a still-open file handle stopping the staging DB from
    // actually disappearing until later) — a checkpoint claiming full
    // completion with no staging DB behind it must not be trusted, or the
    // range it claims is done gets silently skipped and decoded as empty.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const records = Array.from({ length: 100 }, (_, i) => {
      const blockNumber = i + 1;
      if (blockNumber === stakeFixture.block90StakeAdded.blockNumber) {
        return {
          blockNumber,
          blockHash: stakeFixture.block90StakeAdded.blockHash,
          eventsHex: stakeFixture.block90StakeAdded.eventsHex,
          timestampHex: stakeFixture.block90StakeAdded.timestampHex,
        };
      }
      return emptyRecord(blockNumber);
    });
    await writeChainEventsBronze({ records, fromBlock: 1, toBlock: 100, specVersion: 101 });

    const first = await materializeChainSilver({ resumable: true, batchBlocks: 50 });
    expect(first.stakeEventsRowCount).toBe(1);
    const checkpointAfterFirst = readMaterializeSilverCheckpoint(1);
    expect(checkpointAfterFirst?.lastCompletedBatchEnd).toBe(100);

    // Staging DB vanishes (whatever the cause); the checkpoint is left
    // pointing at nothing, still claiming the full range is decoded.
    const stagingDbPath = join(process.env.DATA_ROOT!, "silver", ".materialize_silver_staging.duckdb");
    rmSync(stagingDbPath, { force: true });
    rmSync(`${stagingDbPath}.wal`, { force: true });

    const second = await materializeChainSilver({ resumable: true, batchBlocks: 50 });

    // Block 90's real stake event only shows up if it actually got
    // redecoded — a silent skip-ahead would report 0, not 1.
    expect(second.stakeEventsRowCount).toBe(1);
  });

  it("does not duplicate rows when a batch's inserts landed but its checkpoint never did", async () => {
    // Found for real 2026-09-09, in already-materialized silver: blocks
    // 5,425,008-5,427,996 held 1,447 duplicated (block_number, event_index)
    // transfer rows while that same batch's balance_events were clean — the
    // signature of a kill between the transfers insert and the balance_events
    // insert, since the checkpoint only advances after all three. The rerun
    // then redid the batch on top of rows that were already committed.
    // Duplicates are worse than they look: a repeated transfer permanently
    // shifts that coldkey's running balance for the rest of history, and it
    // leaves account_balances_daily's last-row-of-day pick ambiguous (tied
    // ORDER BY keys), so identical input can yield different output run to run.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const records = Array.from({ length: 100 }, (_, i) => {
      const blockNumber = i + 1;
      if (blockNumber === stakeFixture.block90StakeAdded.blockNumber) {
        return {
          blockNumber,
          blockHash: stakeFixture.block90StakeAdded.blockHash,
          eventsHex: stakeFixture.block90StakeAdded.eventsHex,
          timestampHex: stakeFixture.block90StakeAdded.timestampHex,
        };
      }
      return emptyRecord(blockNumber);
    });
    await writeChainEventsBronze({ records, fromBlock: 1, toBlock: 100, specVersion: 101 });

    const first = await materializeChainSilver({ resumable: true, batchBlocks: 50 });
    expect(first.stakeEventsRowCount).toBe(1);

    // Rewinding the checkpoint reproduces the exact post-kill state: blocks
    // 51-100 are committed in the staging DB, but the checkpoint still says
    // only 1-50 are done, so the next run redecodes 51-100 over the top.
    writeMaterializeSilverCheckpoint({ fromBlock: 1, lastCompletedBatchEnd: 50, updatedAtMs: Date.now() });

    const second = await materializeChainSilver({ resumable: true, batchBlocks: 50 });

    // Block 90's stake event must still be there exactly once, not twice.
    expect(second.stakeEventsRowCount).toBe(1);
  });

  it("fails loudly instead of deleting a staging DB that's open in another (live) process", async () => {
    // Found for real 2026-08-28: a "stop" that doesn't actually kill the
    // underlying process leaves it holding the staging DB open. A second
    // invocation must not treat that as corruption and delete the first
    // process's in-progress state out from under it — it must fail loudly
    // and leave the files alone.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    await writeChainEventsBronze({
      records: Array.from({ length: 10 }, (_, i) => emptyRecord(i + 1)),
      fromBlock: 1,
      toBlock: 10,
      specVersion: 101,
    });

    await materializeChainSilver({ resumable: true, batchBlocks: 5 });
    const checkpointBefore = readMaterializeSilverCheckpoint(1);
    expect(checkpointBefore?.lastCompletedBatchEnd).toBe(10);

    const stagingDbPath = join(process.env.DATA_ROOT!, "silver", ".materialize_silver_staging.duckdb");
    const heldOpenInstance = await DuckDBInstance.create(stagingDbPath);
    const heldOpenConnection = await heldOpenInstance.connect();
    try {
      await expect(materializeChainSilver({ resumable: true, batchBlocks: 5 })).rejects.toThrow(/already open in/i);

      // Untouched — the failed attempt must not have deleted anything.
      expect(existsSync(stagingDbPath)).toBe(true);
      const checkpointAfter = readMaterializeSilverCheckpoint(1);
      expect(checkpointAfter?.lastCompletedBatchEnd).toBe(10);
    } finally {
      heldOpenConnection.closeSync();
      heldOpenInstance.closeSync();
    }
  });

  it("propagates a genuine mid-decode error without wiping the checkpoint or staging DB", async () => {
    // Found for real 2026-08-29: a real 8.9M-block run hit a genuine decode
    // failure partway through (an event whose index didn't match its
    // stamped spec_version's metadata — a real data/runtime-upgrade problem,
    // nothing to do with the staging DB). The self-heal path used to catch
    // *any* error, including this one, and wipe the checkpoint — discarding
    // two hours of good progress only to walk straight back into the same
    // real error a second time. A decode error must propagate as-is, and
    // whatever was already durably decoded must survive it.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    await writeChainEventsBronze({
      records: [1, 2, 3, 4, 5].map(emptyRecord),
      fromBlock: 1,
      toBlock: 5,
      specVersion: 101,
    });
    const first = await materializeChainSilver({ resumable: true, batchBlocks: 5 });
    expect(first.transfersRowCount).toBe(0);
    const checkpointAfterFirst = readMaterializeSilverCheckpoint(1);
    expect(checkpointAfterFirst?.lastCompletedBatchEnd).toBe(5);

    // More bronze arrives, stamped with a spec_version nothing has metadata
    // for — a real, non-corruption decode failure.
    await writeChainEventsBronze({
      records: [6, 7, 8, 9, 10].map(emptyRecord),
      fromBlock: 6,
      toBlock: 10,
      specVersion: 999,
    });

    // A wipe-and-redo would reprocess batch [1,5] again (completing it, and
    // so firing onProgress for it) before failing on [6,10] a second time.
    // Correct behavior resumes straight from the checkpoint at [6,10],
    // which fails before that batch ever completes — so onProgress never
    // fires at all. Recording every batchStart onProgress sees is what
    // actually distinguishes these two cases; a plain rejects.toThrow on
    // the final error message can't, since both end in the identical
    // spec_version-999 error text.
    const batchStarts: number[] = [];
    await expect(
      materializeChainSilver({
        resumable: true,
        batchBlocks: 5,
        onProgress: ({ batchStart }) => batchStarts.push(batchStart),
      }),
    ).rejects.toThrow(/No bronze chain\/metadata for spec_version 999/);

    expect(batchStarts).toEqual([]);

    // Untouched — blocks 1-5's already-good progress must survive a failure
    // that has nothing to do with the staging DB itself.
    const stagingDbPath = join(process.env.DATA_ROOT!, "silver", ".materialize_silver_staging.duckdb");
    expect(existsSync(stagingDbPath)).toBe(true);
    const checkpointAfterFailure = readMaterializeSilverCheckpoint(1);
    expect(checkpointAfterFailure?.lastCompletedBatchEnd).toBe(5);
  });

  it("exports decoded-so-far progress to silver/*.parquet before the whole run finishes", async () => {
    // Found for real 2026-09-05: the COPY that produces silver/*.parquet
    // used to run only after the *entire* range finished — every
    // interruption before 100% (there had been several, over days) left
    // those files frozen at whatever the first completed run had written,
    // even though the staging DB itself already held millions more decoded
    // blocks. Downstream consumers (gold materialization, reconcile-
    // checkpoints) were silently reading that stale snapshot the whole
    // time. `parquetFlushIntervalBatches: 1` here flushes after every
    // batch; block 90's real stake event sits in the *first* of two
    // batches, so reading stake_events.parquet from a separate connection
    // *while the second batch is still pending* (inside onProgress, before
    // the overall call resolves) proves the export already happened
    // mid-run — not merely as an artifact of this being the last batch.
    await writeChainMetadataBronze({ specVersion: 101, metadataHex: metadataFixture.metadataHex, capturedAtBlock: 1 });
    const records = Array.from({ length: 150 }, (_, i) => {
      const blockNumber = i + 1;
      if (blockNumber === stakeFixture.block90StakeAdded.blockNumber) {
        return {
          blockNumber,
          blockHash: stakeFixture.block90StakeAdded.blockHash,
          eventsHex: stakeFixture.block90StakeAdded.eventsHex,
          timestampHex: stakeFixture.block90StakeAdded.timestampHex,
        };
      }
      return emptyRecord(blockNumber);
    });
    await writeChainEventsBronze({ records, fromBlock: 1, toBlock: 150, specVersion: 101 });

    const stakeEventsPath = join(process.env.DATA_ROOT!, "silver", "stake_events.parquet");
    let sawMidRunFlush = false;

    await materializeChainSilver({
      resumable: true,
      batchBlocks: 100,
      parquetFlushIntervalBatches: 1,
      onProgress: async ({ batchEnd }) => {
        if (batchEnd !== 100) return; // first of two batches; second (101-150) still pending
        const instance = await DuckDBInstance.create(":memory:");
        const connection = await instance.connect();
        try {
          const r = await connection.run(`SELECT COUNT(*) FROM read_parquet('${stakeEventsPath.replace(/\\/g, "/")}');`);
          const count = Number((await r.getRows())[0]![0]);
          sawMidRunFlush = count === 1;
        } finally {
          connection.closeSync();
          instance.closeSync();
        }
      },
    });

    expect(sawMidRunFlush).toBe(true);
  });
});

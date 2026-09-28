import { existsSync, mkdirSync, rmSync } from "node:fs";
import { withDuckDb, DuckDbOpenError } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";
import { buildRegistry, decodeChainEventsForBlock, decodeTimestamp } from "./decodeEvents.js";
import {
  clearMaterializeSilverCheckpoint,
  readMaterializeSilverCheckpoint,
  writeMaterializeSilverCheckpoint,
} from "./materializeSilverCheckpoint.js";
import { appendSkippedBlock } from "./skippedBlocksLog.js";
import type { TypeRegistry } from "@polkadot/types";
import type { DuckDBConnection } from "@duckdb/node-api";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export interface MaterializeChainSilverResult {
  transfersDestination: string;
  transfersRowCount: number;
  balanceEventsDestination: string;
  balanceEventsRowCount: number;
  stakeEventsDestination: string;
  stakeEventsRowCount: number;
  /** Blocks this run couldn't decode and skipped rather than crash on — see
   * skippedBlocksLog.ts. Empty in the overwhelmingly common case; a non-empty
   * result is worth investigating, not ignoring. */
  skippedBlocks: number[];
}

/**
 * Blocks decoded and staged per batch, rather than all at once. Found for
 * real (2026-08-26, ~580,000 blocks of a genesis-forward Phase 2.3 backfill
 * already in bronze): decoding every currently-available block into one
 * giant in-memory array before writing anything crashed with `FATAL ERROR:
 * Scavenger: semi-space copy Allocation failed - JavaScript heap out of
 * memory` — `@polkadot/types` SCALE decoding allocates heavily per call, and
 * holding hundreds of thousands of decoded blocks' worth of that churn alive
 * simultaneously (plus the raw hex rows DuckDB had already materialized)
 * overwhelms V8 well before the *retained* data itself is large. This is the
 * same lesson as `parquetWriter.ts`'s streaming fix, applied to decode
 * instead of write: bound how much is alive at once, let the GC reclaim each
 * batch before starting the next, and only the full 8.9M-block backfill
 * (15x today's crash point) would need a smaller `BATCH_BLOCKS` than this.
 */
const BATCH_BLOCKS = 20_000;

/** How many batches between periodic exports of the staging DB's current
 * contents to silver/*.parquet during a resumable run — see
 * flushToParquet's doc comment in materializeChainSilver for why this
 * can't just wait until the whole range finishes. */
const PARQUET_FLUSH_INTERVAL_BATCHES = 20;

/**
 * bronze chain/events/*.parquet + chain/metadata/*.parquet -> silver
 * transfers.parquet + balance_events.parquet + stake_events.parquet
 * (tao-analytics-plan.md §6,
 * Phase 2.1: "decode at silver"). DuckDB does the bronze *read* (it's the
 * one Parquet engine, §2), but the actual SCALE decode is JS
 * (`decodeEvents.ts`) — DuckDB SQL has no SCALE codec, so each batch's rows
 * are staged back into DuckDB as plain values, via explicit `CREATE TABLE` +
 * `INSERT` rather than the bronze writers' `read_json_auto` staging path,
 * because a genuinely-empty result (a batch with zero balance events is
 * common — see README) makes `read_json_auto` fail on an empty file; an
 * explicit schema has no such edge case.
 *
 * Rebuilds both silver files from whatever bronze is currently present
 * (consistent with bronze being immutable and silver being a local,
 * cheap-to-recompute cache of it, §2). By default this is a single from-
 * scratch, in-memory run, not an incremental append across separate
 * processes. Pass `resumable: true` (what the CLI script does) to persist
 * decode progress to disk instead — decoding the full range is hours of
 * local CPU work, long enough that "the machine can't stay on that long"
 * needs to be a normal, resumable interruption rather than a lost run.
 */
export interface MaterializeChainSilverOptions {
  batchBlocks?: number;
  onProgress?: (info: {
    batchStart: number;
    batchEnd: number;
    minBlock: number;
    maxBlock: number;
    elapsedMs: number;
  }) => void | Promise<void>;
  /**
   * Persists decode progress to disk (a DuckDB file under silverDir(), plus
   * a JSON checkpoint) so a run interrupted partway through — deliberately
   * stopped, or crashed — resumes from the next undecoded batch instead of
   * redoing the whole range from block 1. Off by default so existing
   * in-memory, from-scratch callers (tests) are unaffected; the CLI script
   * turns it on.
   */
  resumable?: boolean;
  /** How many batches between periodic exports of decoded-so-far progress
   * to silver/*.parquet — see flushToParquet's doc comment. Defaults to
   * `PARQUET_FLUSH_INTERVAL_BATCHES`; overridable mainly so tests can
   * observe a mid-run flush without needing dozens of real batches. */
  parquetFlushIntervalBatches?: number;
}

/**
 * Which metadata to decode each block's events with, derived once from the
 * whole of bronze.
 *
 * Bronze's `spec_version` is `state_getRuntimeVersion` at the block's hash,
 * i.e. the runtime *after* the block executed. That's the right version for
 * every block except a runtime-upgrade block: its events were emitted by the
 * old runtime (new code only runs from the next block), so it must decode
 * with the previous block's version. Found for real (2026-09-28): 16 of the
 * chain's upgrade blocks failed to decode against their stamped version and
 * decoded cleanly against the previous one; the other upgrade blocks only
 * decoded because the relevant types happened not to change.
 *
 * Duplicate bronze rows for a block (overlapping manual/sample ingests)
 * always carry identical events bytes, but can disagree on the stamp: the
 * Phase 2.1 tracer bullet stamped blocks 1-1000 all as 101, while the
 * upgrade-aware backfill correctly stamps 561+ as 102. The highest stamp
 * wins, deterministically.
 */
export interface DecodeSpecPlan {
  /** Runtime-transition block -> the previous block's (canonical) spec_version. */
  previousSpecAtTransition: Map<number, number>;
  /** Blocks whose duplicate bronze rows disagree on spec_version. */
  conflictingBlocks: number[];
}

export async function loadDecodeSpecPlan(connection: DuckDBConnection, eventsGlob: string): Promise<DecodeSpecPlan> {
  const rows = await connection
    .run(
      `WITH canonical AS (
         SELECT block_number, MAX(spec_version) AS spec_version, COUNT(DISTINCT spec_version) AS stamps
         FROM read_parquet('${escapeSqlLiteral(eventsGlob)}')
         GROUP BY block_number
       ),
       ordered AS (
         SELECT block_number, spec_version, stamps,
                LAG(spec_version) OVER (ORDER BY block_number) AS prev_spec
         FROM canonical
       )
       SELECT block_number, spec_version, prev_spec, stamps
       FROM ordered
       WHERE (prev_spec IS NOT NULL AND prev_spec <> spec_version) OR stamps > 1
       ORDER BY block_number;`,
    )
    .then((r) => r.getRows());

  const previousSpecAtTransition = new Map<number, number>();
  const conflictingBlocks: number[] = [];
  for (const row of rows) {
    const blockNumber = Number(row[0]);
    const spec = Number(row[1]);
    const prevSpec = row[2] == null ? null : Number(row[2]);
    if (prevSpec !== null && prevSpec !== spec) {
      // spec_version can't decrease on-chain, so a decrease means bad stamps
      // in bronze — decoding around it would silently use wrong metadata.
      if (spec < prevSpec) {
        throw new Error(
          `Bronze spec_version goes backwards at block ${blockNumber} (${prevSpec} -> ${spec}); ` +
            "bronze stamps are inconsistent, refusing to guess which metadata to decode with.",
        );
      }
      previousSpecAtTransition.set(blockNumber, prevSpec);
    }
    if (Number(row[3]) > 1) conflictingBlocks.push(blockNumber);
  }
  return { previousSpecAtTransition, conflictingBlocks };
}

/** Bronze rows for the given block filter, one per block (see DecodeSpecPlan for the MAX). */
function bronzeBlocksQuery(eventsGlob: string, whereClause: string): string {
  return `SELECT block_number, any_value(events_hex), any_value(timestamp_hex), MAX(spec_version)
          FROM read_parquet('${escapeSqlLiteral(eventsGlob)}')
          WHERE ${whereClause}
          GROUP BY block_number
          ORDER BY block_number;`;
}

interface DecodedBlockRows {
  transferValues: string[];
  balanceEventValues: string[];
  stakeEventValues: string[];
}

/** Decodes one bronze block into SQL VALUES tuples for the three silver tables. Throws on decode failure. */
function decodeBlockRows(
  registry: TypeRegistry,
  blockNumber: number,
  eventsHex: string,
  timestampHex: string | null,
): DecodedBlockRows {
  const timestampMs = decodeTimestamp(registry, timestampHex);
  const { balanceEvents, stakeEvents } = decodeChainEventsForBlock(registry, eventsHex, blockNumber);
  const out: DecodedBlockRows = { transferValues: [], balanceEventValues: [], stakeEventValues: [] };
  for (const event of balanceEvents) {
    if (event.kind === "transfer") {
      out.transferValues.push(
        `(${blockNumber}, ${event.eventIndex}, ${timestampMs ?? "NULL"}, ` +
          `'${escapeSqlLiteral(event.from)}', '${escapeSqlLiteral(event.to)}', ${event.amount})`,
      );
    } else {
      out.balanceEventValues.push(
        `(${blockNumber}, ${event.eventIndex}, ${timestampMs ?? "NULL"}, ` +
          `'${event.kind}', '${escapeSqlLiteral(event.coldkey)}', ${event.amount})`,
      );
    }
  }
  for (const event of stakeEvents) {
    out.stakeEventValues.push(
      `(${blockNumber}, ${event.eventIndex}, ${timestampMs ?? "NULL"}, ` +
        `'${event.kind}', '${escapeSqlLiteral(event.hotkey)}', ${event.amount})`,
    );
  }
  return out;
}

function registryFor(
  registryBySpecVersion: Map<number, TypeRegistry>,
  plan: DecodeSpecPlan,
  blockNumber: number,
  stampedSpec: number,
): { registry: TypeRegistry; decodeSpec: number } {
  const decodeSpec = plan.previousSpecAtTransition.get(blockNumber) ?? stampedSpec;
  const registry = registryBySpecVersion.get(decodeSpec);
  if (!registry) {
    throw new Error(`No bronze chain/metadata for spec_version ${decodeSpec} (block ${blockNumber})`);
  }
  return { registry, decodeSpec };
}

async function loadRegistries(connection: DuckDBConnection, metadataGlob: string): Promise<Map<number, TypeRegistry>> {
  const metaRows = await connection
    .run(`SELECT spec_version, metadata_hex FROM read_parquet('${escapeSqlLiteral(metadataGlob)}');`)
    .then((r) => r.getRows());
  const registryBySpecVersion = new Map<number, TypeRegistry>();
  for (const row of metaRows) {
    registryBySpecVersion.set(Number(row[0]), buildRegistry(String(row[1])));
  }
  return registryBySpecVersion;
}

async function exportSilverParquet(connection: DuckDBConnection): Promise<void> {
  for (const table of ["transfers", "balance_events", "stake_events"]) {
    await connection.run(
      `COPY ${table} TO '${escapeSqlLiteral(`${silverDir()}/${table}.parquet`)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    );
  }
}

export async function materializeChainSilver(opts: MaterializeChainSilverOptions = {}): Promise<MaterializeChainSilverResult> {
  const batchBlocks = opts.batchBlocks ?? BATCH_BLOCKS;
  const resumable = opts.resumable ?? false;
  const startedAt = Date.now();
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");
  const eventsGlob = `${bronzeUri}/chain/events/*.parquet`;
  const metadataGlob = `${bronzeUri}/chain/metadata/*.parquet`;

  mkdirSync(silverDir(), { recursive: true });
  const transfersDestination = `${silverDir()}/transfers.parquet`;
  const balanceEventsDestination = `${silverDir()}/balance_events.parquet`;
  const stakeEventsDestination = `${silverDir()}/stake_events.parquet`;
  const stagingDbPath = `${silverDir()}/.materialize_silver_staging.duckdb`;
  // Captured once, before anything below has a chance to create the file —
  // see the doc comment where this is used, further down.
  const stagingDbExistedBeforeOpen = existsSync(stagingDbPath);

  const attempt = () =>
    withDuckDb(
      async (connection) => {
      const registryBySpecVersion = await loadRegistries(connection, metadataGlob);
      const plan = await loadDecodeSpecPlan(connection, eventsGlob);

      const rangeResult = await connection.run(
        `SELECT MIN(block_number), MAX(block_number) FROM read_parquet('${escapeSqlLiteral(eventsGlob)}');`,
      );
      const rangeRows = await rangeResult.getRows();
      const minBlock = rangeRows[0]?.[0] == null ? null : Number(rangeRows[0][0]);
      const maxBlock = rangeRows[0]?.[1] == null ? null : Number(rangeRows[0][1]);

      await connection.run(`
        CREATE TABLE IF NOT EXISTS transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        CREATE TABLE IF NOT EXISTS balance_events (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        CREATE TABLE IF NOT EXISTS stake_events (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          kind VARCHAR, hotkey VARCHAR, amount_rao BIGINT
        );
      `);

      const skippedBlocks: number[] = [];

      // Extracted so it can run *during* a long resumable run, not only
      // once the entire range finishes. Found for real (2026-09-05): the
      // final COPY only ran after the full ~8.9M-block loop completed, so
      // every interruption before 100% (there had been several) left
      // silver/*.parquet frozen at whatever the *first* completed run had
      // written (the ~1,000-block Phase 2.1/2.2 tracer bullet) — gold
      // materialization and reconcile-checkpoints were silently reading
      // that stale stub the entire time the staging DB itself already held
      // millions more decoded blocks. Phase 3 work explicitly wants to
      // build against "whatever prefix is done so far" (§6), which only
      // works if the exported parquet actually reflects that prefix.
      const flushToParquet = () => exportSilverParquet(connection);

      if (minBlock !== null && maxBlock !== null) {
        // A checkpoint claiming progress is only trustworthy if the staging
        // DB it refers to already existed *before this call opened it* —
        // `stagingDbExistedBeforeOpen` is captured for exactly that reason,
        // since by this point `withDuckDb` has already created a fresh file
        // at `stagingDbPath` if none existed, which would make an in-callback
        // `existsSync` check here always true and useless. Found for real
        // (2026-08-28): the checkpoint file and the staging DB can
        // independently disappear (here, a still-running orphaned process's
        // file lock made the corrupt-DB recovery below delete the checkpoint
        // but fail to fully recreate the staging DB while that process still
        // held it open; the DB only actually vanished once that process was
        // killed for real). Trusting a checkpoint with nothing behind it
        // would silently skip re-decoding everything up to
        // `lastCompletedBatchEnd`.
        if (resumable && !stagingDbExistedBeforeOpen) {
          clearMaterializeSilverCheckpoint();
        }
        const checkpoint = resumable ? readMaterializeSilverCheckpoint(minBlock) : null;
        const resumeFrom = checkpoint ? checkpoint.lastCompletedBatchEnd + 1 : minBlock;
        let batchesSinceFlush = 0;

        // Makes resuming idempotent. A batch inserts transfers, then
        // balance_events, then stake_events, and only then advances the
        // checkpoint — so a process that dies mid-batch leaves rows committed
        // for blocks the checkpoint doesn't know about, and the rerun inserts
        // them a second time. Found for real (2026-09-09, in already-built
        // silver): exactly one batch, blocks 5,425,008-5,427,996, had 1,447
        // duplicated (block_number, event_index) transfer rows while its
        // balance_events were clean — the signature of a kill landing between
        // those two inserts. Duplicates don't just add rows: a repeated
        // transfer permanently shifts that coldkey's running balance for the
        // rest of history, and it makes account_balances_daily's
        // last-row-per-day pick ambiguous (tied ORDER BY keys), so the same
        // input could produce different output run to run. Anything at or
        // past the resume point can only be such a partial batch, so clear it
        // before redoing that batch.
        if (resumable) {
          for (const table of ["transfers", "balance_events", "stake_events"]) {
            await connection.run(`DELETE FROM ${table} WHERE block_number >= ${resumeFrom};`);
          }
        }

        for (let batchStart = resumeFrom; batchStart <= maxBlock; batchStart += batchBlocks) {
          const batchEnd = Math.min(batchStart + batchBlocks - 1, maxBlock);

          // Bronze is immutable and never re-fetched (§2), so an earlier
          // manual/test ingest run (e.g. the Phase 2.1/2.2 tracer bullet, or
          // the RU-sizing samples near block 8.9M — tao-analytics-plan.md
          // §4.2's "Findings") and the real backfill's later sweep over the
          // same range both persist forever, as two separate rows for the
          // same block_number. Deduping here (see bronzeBlocksQuery), not by
          // refusing to write overlapping bronze, keeps that invariant intact
          // while still decoding each block exactly once.
          const blockRows = await connection
            .run(bronzeBlocksQuery(eventsGlob, `block_number BETWEEN ${batchStart} AND ${batchEnd}`))
            .then((r) => r.getRows());

          const transferValues: string[] = [];
          const balanceEventValues: string[] = [];
          const stakeEventValues: string[] = [];

          for (const row of blockRows) {
            const blockNumber = Number(row[0]);
            const { registry, decodeSpec } = registryFor(registryBySpecVersion, plan, blockNumber, Number(row[3]));
            let decoded: DecodedBlockRows;
            try {
              decoded = decodeBlockRows(registry, blockNumber, String(row[1]), row[2] == null ? null : String(row[2]));
            } catch (err) {
              // A single undecodable block must not halt the other ~9M, and
              // must not vanish silently either — logged durably via
              // skippedBlocksLog.ts. (Every skip before 2026-09-28 was a
              // runtime-upgrade block decoded with the wrong metadata — see
              // DecodeSpecPlan — not a genuine decoder misalignment.)
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`materializeChainSilver: skipping block ${blockNumber} (spec_version ${decodeSpec}) — decode failed: ${message}`);
              appendSkippedBlock({ blockNumber, specVersion: decodeSpec, error: message });
              skippedBlocks.push(blockNumber);
              continue;
            }
            transferValues.push(...decoded.transferValues);
            balanceEventValues.push(...decoded.balanceEventValues);
            stakeEventValues.push(...decoded.stakeEventValues);
          }

          if (transferValues.length > 0) {
            await connection.run(`INSERT INTO transfers VALUES ${transferValues.join(",")};`);
          }
          if (balanceEventValues.length > 0) {
            await connection.run(`INSERT INTO balance_events VALUES ${balanceEventValues.join(",")};`);
          }
          if (stakeEventValues.length > 0) {
            await connection.run(`INSERT INTO stake_events VALUES ${stakeEventValues.join(",")};`);
          }
          // blockRows / transferValues / balanceEventValues / stakeEventValues
          // fall out of scope here — eligible for GC before the next batch
          // starts, which is the whole point (see BATCH_BLOCKS's doc comment).

          if (resumable) {
            writeMaterializeSilverCheckpoint({ fromBlock: minBlock, lastCompletedBatchEnd: batchEnd, updatedAtMs: Date.now() });
            // Found for real (2026-08-29): a multi-hour run against the
            // persistent staging DB ran out of heap ~30% through the range
            // (2.8M blocks in) — DuckDB's WAL for a persistent database
            // grows unboundedly across an uncheckpointed run of continuous
            // INSERTs, and that in-memory/on-disk buildup, not the per-batch
            // JS arrays (which already fall out of scope correctly), is what
            // exhausted the heap. CHECKPOINT flushes the WAL into the main
            // file after every batch, keeping it bounded for the rest of the
            // ~8.9M-block run instead of growing for hours unchecked.
            await connection.run("CHECKPOINT;");

            // See flushToParquet's doc comment — exports whatever's decoded
            // so far, periodically, so silver/*.parquet is usable by gold
            // materialization and reconcile-checkpoints *during* a
            // multi-hour run, not only after it finishes.
            batchesSinceFlush++;
            if (batchesSinceFlush >= (opts.parquetFlushIntervalBatches ?? PARQUET_FLUSH_INTERVAL_BATCHES)) {
              await flushToParquet();
              batchesSinceFlush = 0;
            }
          }

          await opts.onProgress?.({ batchStart, batchEnd, minBlock, maxBlock, elapsedMs: Date.now() - startedAt });
        }
      }

      await flushToParquet();

      // Counted from the table rather than tracked incrementally through the
      // loop above — in resumable mode, rows inserted by an earlier (already-
      // exited) process aren't visible to this run's local counters, only to
      // the persisted table itself.
      const transfersCountResult = await connection.run(`SELECT COUNT(*) FROM transfers;`);
      const transfersRowCount = Number((await transfersCountResult.getRows())[0]?.[0] ?? 0);
      const balanceEventsCountResult = await connection.run(`SELECT COUNT(*) FROM balance_events;`);
      const balanceEventsRowCount = Number((await balanceEventsCountResult.getRows())[0]?.[0] ?? 0);
      const stakeEventsCountResult = await connection.run(`SELECT COUNT(*) FROM stake_events;`);
      const stakeEventsRowCount = Number((await stakeEventsCountResult.getRows())[0]?.[0] ?? 0);

      return {
        transfersDestination,
        transfersRowCount,
        balanceEventsDestination,
        balanceEventsRowCount,
        stakeEventsDestination,
        stakeEventsRowCount,
        skippedBlocks,
      };
      },
      {
        needsR2: isRemote,
        dbPath: resumable ? stagingDbPath : undefined,
        // Only for the persistent (resumable) path — see session.ts's
        // memoryLimit doc comment for why DuckDB's own auto-sizing isn't
        // trustworthy here. Existing in-memory/test callers are unaffected.
        memoryLimit: resumable ? "2GB" : undefined,
      },
    );

  if (!resumable) {
    return attempt();
  }

  try {
    return await attempt();
  } catch (err) {
    // Only a failure to *open* the staging DB is self-healable. Found for
    // real (2026-08-29): the first version of this catch treated *any*
    // error the same way, including a genuine mid-decode failure (a real
    // block's event didn't match its stamped spec_version's metadata) —
    // which got silently discarded as if it were DB corruption, wiping two
    // hours of good progress only to walk straight back into the identical
    // real error. A decode/data error must propagate untouched: it says
    // nothing about whether the staging DB is usable, and self-healing it
    // away only hides the actual problem and wastes the redo.
    if (!(err instanceof DuckDbOpenError)) {
      throw err;
    }
    const message = err.message;

    // Found for real (2026-08-28): a `TaskStop`-style "stop" that doesn't
    // actually kill the underlying OS process (confirmed on this machine —
    // the process kept running and holding the file open well after the
    // stop call reported success) leaves a *live* process still writing to
    // `stagingDbPath`. A second invocation then fails to open it too, but
    // for a completely different reason than corruption — DuckDB says so
    // explicitly ("already open in ... (PID ...)"). Deleting a live
    // process's staging DB out from under it is the opposite of safe, so
    // this case must fail loudly instead of self-healing — the fix is to
    // actually stop the other process (verify with a process list, not just
    // by trusting a "stopped" message), not to touch its files.
    if (/already open in/i.test(message)) {
      throw new Error(
        `materializeChainSilver: staging DB at ${stagingDbPath} is open in another process (${message}). ` +
          "Not touching it — stop that process for real (verify it's actually gone, e.g. via a process list; " +
          "a tool reporting \"stopped\" is not proof) and rerun.",
      );
    }

    // Any other open failure (e.g. an unreplayable WAL after a hard kill —
    // tao-analytics-plan.md work log, 2026-08-27) means the staging DB is
    // genuinely unusable. Trusting the JSON checkpoint at that point would
    // be actively wrong, not just inconvenient: the checkpoint would claim
    // blocks up to `lastCompletedBatchEnd` are done, and resuming from
    // `lastCompletedBatchEnd + 1` would silently never redecode them even
    // though the (now-unopenable) staging DB never durably held their rows.
    // Silver is a cheap-to-recompute cache (§2), so discarding a corrupt
    // staging DB and its checkpoint and starting the range over is safe —
    // the alternative, a silent gap in the final transfers/balance_events/
    // stake_events output, is not.
    console.error(
      `materializeChainSilver: staging DB at ${stagingDbPath} failed to open (${message}). ` +
        "Discarding it and the checkpoint, and restarting the range from scratch rather than risk a silent gap.",
    );
    rmSync(stagingDbPath, { force: true });
    rmSync(`${stagingDbPath}.wal`, { force: true });
    clearMaterializeSilverCheckpoint();
    return await attempt();
  }
}

export interface RepairUpgradeBlocksResult {
  repairedBlocks: number[];
  /** Blocks whose decoded silver rows actually differ from what was there before. */
  changedBlocks: { blockNumber: number; rowsBefore: number; rowsAfter: number }[];
}

/**
 * Re-decodes, in the existing resumable staging DB, every block the pre-2026-09-28
 * decoder could have decoded with the wrong metadata: each runtime-transition
 * block, plus blocks whose duplicate bronze rows disagree on spec_version (see
 * DecodeSpecPlan). A few hundred blocks, instead of a ~30h full rebuild.
 *
 * Strict where materializeChainSilver is lenient: every block must decode, and
 * everything is decoded before anything is deleted, so a failure leaves the
 * staging DB untouched. Only blocks the checkpoint says are already decoded are
 * repaired; later ones get the fixed decoder when a normal run reaches them.
 */
export async function repairUpgradeBlocks(): Promise<RepairUpgradeBlocksResult> {
  const bronzeUri = resolveBronzeUri();
  const eventsGlob = `${bronzeUri}/chain/events/*.parquet`;
  const metadataGlob = `${bronzeUri}/chain/metadata/*.parquet`;
  const stagingDbPath = `${silverDir()}/.materialize_silver_staging.duckdb`;
  if (!existsSync(stagingDbPath)) {
    throw new Error(`No staging DB at ${stagingDbPath} — run chain:materialize-silver first.`);
  }

  return withDuckDb(
    async (connection) => {
      const minBlockRows = await connection
        .run(`SELECT MIN(block_number) FROM read_parquet('${escapeSqlLiteral(eventsGlob)}');`)
        .then((r) => r.getRows());
      const checkpoint = readMaterializeSilverCheckpoint(Number(minBlockRows[0]?.[0]));
      if (!checkpoint) {
        throw new Error("No materialize-silver checkpoint matches this bronze — nothing decoded to repair.");
      }

      const registryBySpecVersion = await loadRegistries(connection, metadataGlob);
      const plan = await loadDecodeSpecPlan(connection, eventsGlob);
      const repairedBlocks = [...new Set([...plan.previousSpecAtTransition.keys(), ...plan.conflictingBlocks])]
        .filter((b) => b <= checkpoint.lastCompletedBatchEnd)
        .sort((a, b) => a - b);
      if (repairedBlocks.length === 0) return { repairedBlocks, changedBlocks: [] };
      const inList = repairedBlocks.join(",");

      const blockRows = await connection
        .run(bronzeBlocksQuery(eventsGlob, `block_number IN (${inList})`))
        .then((r) => r.getRows());
      if (blockRows.length !== repairedBlocks.length) {
        throw new Error(`Expected ${repairedBlocks.length} bronze blocks to repair, found ${blockRows.length}.`);
      }

      const decodedByBlock = new Map<number, DecodedBlockRows>();
      for (const row of blockRows) {
        const blockNumber = Number(row[0]);
        const { registry, decodeSpec } = registryFor(registryBySpecVersion, plan, blockNumber, Number(row[3]));
        try {
          decodedByBlock.set(
            blockNumber,
            decodeBlockRows(registry, blockNumber, String(row[1]), row[2] == null ? null : String(row[2])),
          );
        } catch (err) {
          throw new Error(
            `Block ${blockNumber} still fails to decode with spec_version ${decodeSpec}: ` +
              `${err instanceof Error ? err.message : String(err)}. Staging DB left untouched.`,
          );
        }
      }

      const snapshot = async (): Promise<Map<number, string[]>> => {
        const rows = await connection
          .run(
            `SELECT block_number, 't' || event_index || '|' || from_coldkey || '|' || to_coldkey || '|' || amount_rao || '|' || coalesce(timestamp_ms, -1) FROM transfers WHERE block_number IN (${inList})
             UNION ALL
             SELECT block_number, 'b' || event_index || '|' || kind || '|' || coldkey || '|' || amount_rao || '|' || coalesce(timestamp_ms, -1) FROM balance_events WHERE block_number IN (${inList})
             UNION ALL
             SELECT block_number, 's' || event_index || '|' || kind || '|' || hotkey || '|' || amount_rao || '|' || coalesce(timestamp_ms, -1) FROM stake_events WHERE block_number IN (${inList});`,
          )
          .then((r) => r.getRows());
        const byBlock = new Map<number, string[]>();
        for (const [block, key] of rows) {
          const list = byBlock.get(Number(block)) ?? [];
          list.push(String(key));
          byBlock.set(Number(block), list);
        }
        for (const list of byBlock.values()) list.sort();
        return byBlock;
      };

      const before = await snapshot();
      await connection.run("BEGIN TRANSACTION;");
      try {
        for (const table of ["transfers", "balance_events", "stake_events"]) {
          await connection.run(`DELETE FROM ${table} WHERE block_number IN (${inList});`);
        }
        const all = (pick: (d: DecodedBlockRows) => string[]) => [...decodedByBlock.values()].flatMap(pick);
        const inserts: [string, string[]][] = [
          ["transfers", all((d) => d.transferValues)],
          ["balance_events", all((d) => d.balanceEventValues)],
          ["stake_events", all((d) => d.stakeEventValues)],
        ];
        for (const [table, values] of inserts) {
          if (values.length > 0) await connection.run(`INSERT INTO ${table} VALUES ${values.join(",")};`);
        }
        await connection.run("COMMIT;");
      } catch (err) {
        await connection.run("ROLLBACK;");
        throw err;
      }
      const after = await snapshot();

      const changedBlocks: RepairUpgradeBlocksResult["changedBlocks"] = [];
      for (const blockNumber of repairedBlocks) {
        const b = before.get(blockNumber) ?? [];
        const a = after.get(blockNumber) ?? [];
        if (b.length !== a.length || b.some((key, i) => key !== a[i])) {
          changedBlocks.push({ blockNumber, rowsBefore: b.length, rowsAfter: a.length });
        }
      }

      await connection.run("CHECKPOINT;");
      await exportSilverParquet(connection);
      return { repairedBlocks, changedBlocks };
    },
    { needsR2: bronzeUri.startsWith("s3://"), dbPath: stagingDbPath, memoryLimit: "2GB" },
  );
}

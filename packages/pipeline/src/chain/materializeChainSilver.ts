import { mkdirSync } from "node:fs";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";
import { buildRegistry, decodeBalanceEventsForBlock, decodeTimestamp } from "./decodeEvents.js";
import type { TypeRegistry } from "@polkadot/types";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export interface MaterializeChainSilverResult {
  transfersDestination: string;
  transfersRowCount: number;
  balanceEventsDestination: string;
  balanceEventsRowCount: number;
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

/**
 * bronze chain/events/*.parquet + chain/metadata/*.parquet -> silver
 * transfers.parquet + balance_events.parquet (tao-analytics-plan.md §6,
 * Phase 2.1: "decode at silver"). DuckDB does the bronze *read* (it's the
 * one Parquet engine, §2), but the actual SCALE decode is JS
 * (`decodeEvents.ts`) — DuckDB SQL has no SCALE codec, so each batch's rows
 * are staged back into DuckDB as plain values, via explicit `CREATE TABLE` +
 * `INSERT` rather than the bronze writers' `read_json_auto` staging path,
 * because a genuinely-empty result (a batch with zero balance events is
 * common — see README) makes `read_json_auto` fail on an empty file; an
 * explicit schema has no such edge case.
 *
 * Always rebuilds both silver files from scratch from whatever bronze is
 * currently present (consistent with bronze being immutable and silver being
 * a local, cheap-to-recompute cache of it, §2) — this is not an incremental
 * append across separate runs, only a batched *single* run.
 */
export interface MaterializeChainSilverOptions {
  batchBlocks?: number;
  onProgress?: (info: { batchStart: number; batchEnd: number; minBlock: number; maxBlock: number; elapsedMs: number }) => void;
}

export async function materializeChainSilver(opts: MaterializeChainSilverOptions = {}): Promise<MaterializeChainSilverResult> {
  const batchBlocks = opts.batchBlocks ?? BATCH_BLOCKS;
  const startedAt = Date.now();
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");
  const eventsGlob = `${bronzeUri}/chain/events/*.parquet`;
  const metadataGlob = `${bronzeUri}/chain/metadata/*.parquet`;

  mkdirSync(silverDir(), { recursive: true });
  const transfersDestination = `${silverDir()}/transfers.parquet`;
  const balanceEventsDestination = `${silverDir()}/balance_events.parquet`;

  return withDuckDb(
    async (connection) => {
      const metaResult = await connection.run(
        `SELECT spec_version, metadata_hex FROM read_parquet('${escapeSqlLiteral(metadataGlob)}');`,
      );
      const metaRows = await metaResult.getRows();
      const registryBySpecVersion = new Map<number, TypeRegistry>();
      for (const row of metaRows) {
        registryBySpecVersion.set(Number(row[0]), buildRegistry(String(row[1])));
      }

      const rangeResult = await connection.run(
        `SELECT MIN(block_number), MAX(block_number) FROM read_parquet('${escapeSqlLiteral(eventsGlob)}');`,
      );
      const rangeRows = await rangeResult.getRows();
      const minBlock = rangeRows[0]?.[0] == null ? null : Number(rangeRows[0][0]);
      const maxBlock = rangeRows[0]?.[1] == null ? null : Number(rangeRows[0][1]);

      await connection.run(`
        CREATE TABLE transfers (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`
        CREATE TABLE balance_events (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
        );
      `);

      let transfersRowCount = 0;
      let balanceEventsRowCount = 0;

      if (minBlock !== null && maxBlock !== null) {
        for (let batchStart = minBlock; batchStart <= maxBlock; batchStart += batchBlocks) {
          const batchEnd = Math.min(batchStart + batchBlocks - 1, maxBlock);

          const blockResult = await connection.run(
            `SELECT block_number, events_hex, timestamp_hex, spec_version
             FROM read_parquet('${escapeSqlLiteral(eventsGlob)}')
             WHERE block_number BETWEEN ${batchStart} AND ${batchEnd}
             ORDER BY block_number;`,
          );
          const blockRows = await blockResult.getRows();

          const transferValues: string[] = [];
          const balanceEventValues: string[] = [];

          for (const row of blockRows) {
            const blockNumber = Number(row[0]);
            const eventsHex = String(row[1]);
            const timestampHex = row[2] == null ? null : String(row[2]);
            const specVersion = Number(row[3]);
            const registry = registryBySpecVersion.get(specVersion);
            if (!registry) {
              throw new Error(`No bronze chain/metadata for spec_version ${specVersion} (block ${blockNumber})`);
            }

            const timestampMs = decodeTimestamp(registry, timestampHex);
            const events = decodeBalanceEventsForBlock(registry, eventsHex, blockNumber);
            for (const event of events) {
              if (event.kind === "transfer") {
                transferValues.push(
                  `(${blockNumber}, ${event.eventIndex}, ${timestampMs ?? "NULL"}, ` +
                    `'${escapeSqlLiteral(event.from)}', '${escapeSqlLiteral(event.to)}', ${event.amount})`,
                );
              } else {
                balanceEventValues.push(
                  `(${blockNumber}, ${event.eventIndex}, ${timestampMs ?? "NULL"}, ` +
                    `'${event.kind}', '${escapeSqlLiteral(event.coldkey)}', ${event.amount})`,
                );
              }
            }
          }

          if (transferValues.length > 0) {
            await connection.run(`INSERT INTO transfers VALUES ${transferValues.join(",")};`);
            transfersRowCount += transferValues.length;
          }
          if (balanceEventValues.length > 0) {
            await connection.run(`INSERT INTO balance_events VALUES ${balanceEventValues.join(",")};`);
            balanceEventsRowCount += balanceEventValues.length;
          }
          // blockRows / transferValues / balanceEventValues fall out of scope
          // here — eligible for GC before the next batch starts, which is the
          // whole point (see BATCH_BLOCKS's doc comment).

          opts.onProgress?.({ batchStart, batchEnd, minBlock, maxBlock, elapsedMs: Date.now() - startedAt });
        }
      }

      await connection.run(`COPY transfers TO '${escapeSqlLiteral(transfersDestination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
      await connection.run(
        `COPY balance_events TO '${escapeSqlLiteral(balanceEventsDestination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
      );

      return { transfersDestination, transfersRowCount, balanceEventsDestination, balanceEventsRowCount };
    },
    { needsR2: isRemote },
  );
}

import { mkdirSync } from "node:fs";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";
import { buildRegistry, decodeBalanceEventsForBlock, decodeTimestamp } from "./decodeEvents.js";
import type { TypeRegistry } from "@polkadot/types";
import type { BalanceEvent } from "@tao-tools/core";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export interface MaterializeChainSilverResult {
  transfersDestination: string;
  transfersRowCount: number;
  balanceEventsDestination: string;
  balanceEventsRowCount: number;
}

interface DecodedBlock {
  blockNumber: number;
  timestampMs: number | null;
  events: BalanceEvent[];
}

/**
 * bronze chain/events/*.parquet + chain/metadata/*.parquet -> silver
 * transfers.parquet + balance_events.parquet (tao-analytics-plan.md §6,
 * Phase 2.1: "decode at silver"). DuckDB does the bronze *read* (it's the
 * one Parquet engine, §2), but the actual SCALE decode is JS
 * (`decodeEvents.ts`) — DuckDB SQL has no SCALE codec, so the rows are
 * staged back into DuckDB as plain values afterward, via explicit `CREATE
 * TABLE` + `INSERT` rather than the bronze writers' `read_json_auto`
 * staging path, because a genuinely-empty result (this 1,000-block tracer
 * bullet has zero balance events — see README) makes `read_json_auto` fail
 * on an empty file; an explicit schema has no such edge case.
 */
export async function materializeChainSilver(): Promise<MaterializeChainSilverResult> {
  const bronzeUri = resolveBronzeUri();
  const isRemote = bronzeUri.startsWith("s3://");
  const eventsGlob = `${bronzeUri}/chain/events/*.parquet`;
  const metadataGlob = `${bronzeUri}/chain/metadata/*.parquet`;

  const decodedBlocks = await withDuckDb(async (connection) => {
    const metaResult = await connection.run(
      `SELECT spec_version, metadata_hex FROM read_parquet('${escapeSqlLiteral(metadataGlob)}');`,
    );
    const metaRows = await metaResult.getRows();
    const registryBySpecVersion = new Map<number, TypeRegistry>();
    for (const row of metaRows) {
      registryBySpecVersion.set(Number(row[0]), buildRegistry(String(row[1])));
    }

    const blockResult = await connection.run(
      `SELECT block_number, events_hex, timestamp_hex, spec_version
       FROM read_parquet('${escapeSqlLiteral(eventsGlob)}')
       ORDER BY block_number;`,
    );
    const blockRows = await blockResult.getRows();

    const decoded: DecodedBlock[] = [];
    for (const row of blockRows) {
      const blockNumber = Number(row[0]);
      const eventsHex = String(row[1]);
      const timestampHex = row[2] == null ? null : String(row[2]);
      const specVersion = Number(row[3]);
      const registry = registryBySpecVersion.get(specVersion);
      if (!registry) {
        throw new Error(`No bronze chain/metadata for spec_version ${specVersion} (block ${blockNumber})`);
      }
      decoded.push({
        blockNumber,
        timestampMs: decodeTimestamp(registry, timestampHex),
        events: decodeBalanceEventsForBlock(registry, eventsHex, blockNumber),
      });
    }
    return decoded;
  }, { needsR2: isRemote });

  mkdirSync(silverDir(), { recursive: true });

  const transfersResult = await writeTransfersSilver(decodedBlocks);
  const balanceEventsResult = await writeBalanceEventsSilver(decodedBlocks);

  return {
    transfersDestination: transfersResult.destination,
    transfersRowCount: transfersResult.rowCount,
    balanceEventsDestination: balanceEventsResult.destination,
    balanceEventsRowCount: balanceEventsResult.rowCount,
  };
}

async function writeTransfersSilver(blocks: readonly DecodedBlock[]): Promise<{ destination: string; rowCount: number }> {
  const destination = `${silverDir()}/transfers.parquet`;
  const values: string[] = [];
  for (const block of blocks) {
    for (const event of block.events) {
      if (event.kind !== "transfer") continue;
      values.push(
        `(${block.blockNumber}, ${event.eventIndex}, ${block.timestampMs ?? "NULL"}, ` +
          `'${escapeSqlLiteral(event.from)}', '${escapeSqlLiteral(event.to)}', ${event.amount})`,
      );
    }
  }

  return withDuckDb(async (connection) => {
    await connection.run(`
      CREATE TABLE transfers (
        block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
        from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
      );
    `);
    if (values.length > 0) {
      await connection.run(`INSERT INTO transfers VALUES ${values.join(",")};`);
    }
    await connection.run(`COPY transfers TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`);
    return { destination, rowCount: values.length };
  });
}

async function writeBalanceEventsSilver(
  blocks: readonly DecodedBlock[],
): Promise<{ destination: string; rowCount: number }> {
  const destination = `${silverDir()}/balance_events.parquet`;
  const values: string[] = [];
  for (const block of blocks) {
    for (const event of block.events) {
      if (event.kind === "transfer") continue;
      values.push(
        `(${block.blockNumber}, ${event.eventIndex}, ${block.timestampMs ?? "NULL"}, ` +
          `'${event.kind}', '${escapeSqlLiteral(event.coldkey)}', ${event.amount})`,
      );
    }
  }

  return withDuckDb(async (connection) => {
    await connection.run(`
      CREATE TABLE balance_events (
        block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
        kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT
      );
    `);
    if (values.length > 0) {
      await connection.run(`INSERT INTO balance_events VALUES ${values.join(",")};`);
    }
    await connection.run(
      `COPY balance_events TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    );
    return { destination, rowCount: values.length };
  });
}

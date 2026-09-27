import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DuckDBConnection } from "@duckdb/node-api";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadRegistry } from "../src/registry/loader.js";

const REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

// Real mainnet subtensor pallet accounts (see packages/core/test/palletAccount.test.ts).
const SUBTENSOR_MAIN = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const SUBTENSOR_SUBNET_97 = "5EYCAe5jLQhn6ofDSwHa4JN7ucQgnSmZLMAzchJya5D4zq8v";

function sqlFor(name: string): string {
  const entry = loadRegistry(REGISTRY_PATH).find((e) => e.name === name);
  if (!entry) throw new Error(`registry has no "${name}" entry`);
  return entry.sql;
}

async function setUpTables(connection: DuckDBConnection, transferValues: string | null): Promise<void> {
  await connection.run(`
    CREATE TABLE silver_transfers (
      block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
      from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
    );
  `);
  if (transferValues) await connection.run(`INSERT INTO silver_transfers VALUES ${transferValues};`);
  // Stands in for the table materializeGold builds with core's palletIdOf.
  await connection.run(`
    CREATE TABLE pallet_accounts (coldkey VARCHAR, pallet_id VARCHAR);
    INSERT INTO pallet_accounts VALUES ('${SUBTENSOR_MAIN}', 'subtensr'), ('${SUBTENSOR_SUBNET_97}', 'subtensr');
  `);
}

async function run(sql: string, transferValues: string | null): Promise<[number, number][]> {
  const rows = await withDuckDb(async (connection) => {
    await setUpTables(connection, transferValues);
    return (await connection.run(sql)).getRows();
  });
  return rows.map((r) => [Number(r[0]), Number(r[1])]);
}

// Day 0: two user transfers, one pallet->pallet sweep, one pallet->user payout.
// Day 1: one user transfer, one user->pallet transfer.
const MIXED = `
  (10, 0, 1000,     '5Alice', '5Bob',   1000000000),
  (10, 1, 5000,     '5Bob',   '5Carol',  500000000),
  (10, 2, 6000,     '${SUBTENSOR_SUBNET_97}', '${SUBTENSOR_MAIN}', 123788),
  (10, 3, 7000,     '${SUBTENSOR_MAIN}', '5Alice', 70000),
  (11, 0, 86401000, '5Carol', '5Alice',  200000000),
  (11, 1, 86402000, '5Bob',   '${SUBTENSOR_MAIN}', 1000)
`;

/**
 * Tier 2 (tao-analytics-plan.md §5): registry SQL run verbatim against a
 * small hand-authored fixture. v3 splits user transfers from pallet-touching
 * ones — see the registry changelog for the runtime-411 sweep volume that
 * made v2 read as an 80x activity surge.
 */
describe("transfer_count_daily registry SQL (user transfers)", () => {
  it("counts per UTC day only transfers where neither leg is a pallet account", async () => {
    expect(await run(sqlFor("transfer_count_daily"), MIXED)).toEqual([
      [0, 2],
      [86400000, 1],
    ]);
  });

  it("returns no rows when silver_transfers is empty", async () => {
    expect(await run(sqlFor("transfer_count_daily"), null)).toEqual([]);
  });
});

describe("transfer_count_protocol_daily registry SQL", () => {
  it("counts per UTC day transfers where either leg is a pallet account", async () => {
    expect(await run(sqlFor("transfer_count_protocol_daily"), MIXED)).toEqual([
      [0, 2], // sweep + payout
      [86400000, 1], // user -> pallet
    ]);
  });

  it("is the exact complement of transfer_count_daily", async () => {
    const user = await run(sqlFor("transfer_count_daily"), MIXED);
    const protocol = await run(sqlFor("transfer_count_protocol_daily"), MIXED);
    const total = [...user, ...protocol].reduce((sum, [, n]) => sum + n, 0);
    expect(total).toBe(6);
  });
});

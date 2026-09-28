import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asBlockNumber, asColdkey, asRao, type BalanceEvent } from "@tao-tools/core";
import { withDuckDb } from "../src/duckdb/session.js";
import { loadWindowNetDeltasFromSilver, netDeltasFromEvents } from "../src/chain/reconcileBalances.js";
import { silverDir } from "../src/paths.js";

const transfer = (block: number, index: number, from: string, to: string, amount: bigint): BalanceEvent => ({
  kind: "transfer",
  blockNumber: asBlockNumber(block),
  eventIndex: index,
  from: asColdkey(from),
  to: asColdkey(to),
  amount: asRao(amount),
});
const balance = (block: number, index: number, kind: "deposit" | "withdraw", coldkey: string, amount: bigint): BalanceEvent => ({
  kind,
  blockNumber: asBlockNumber(block),
  eventIndex: index,
  coldkey: asColdkey(coldkey),
  amount: asRao(amount),
});

const EVENTS: BalanceEvent[] = [
  transfer(5, 0, "5Alice", "5Bob", 100n), // before the window
  transfer(10, 0, "5Alice", "5Bob", 40n),
  transfer(11, 1, "5Carol", "5Carol", 7n), // self-transfer: touched, net 0
  balance(12, 0, "withdraw", "5Bob", 3n),
  balance(12, 1, "deposit", "5Dave", 9n),
  transfer(21, 0, "5Bob", "5Alice", 1n), // after the window
];

/** The silver query must agree exactly with the in-memory fold it replaced. */
describe("loadWindowNetDeltasFromSilver", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-net-deltas-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
    mkdirSync(silverDir(), { recursive: true });

    const transfers = EVENTS.filter((e) => e.kind === "transfer").map(
      (e) => `(${e.blockNumber}, ${e.eventIndex}, 0, '${e.from}', '${e.to}', ${e.amount})`,
    );
    const balanceEvents = EVENTS.filter((e) => e.kind !== "transfer").map(
      (e) => `(${e.blockNumber}, ${e.eventIndex}, 0, '${e.kind}', '${e.coldkey}', ${e.amount})`,
    );
    await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE t (block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT, from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT);
        INSERT INTO t VALUES ${transfers.join(",")};
        COPY t TO '${silverDir()}/transfers.parquet' (FORMAT PARQUET);
        CREATE TABLE b (block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT, kind VARCHAR, coldkey VARCHAR, amount_rao BIGINT);
        INSERT INTO b VALUES ${balanceEvents.join(",")};
        COPY b TO '${silverDir()}/balance_events.parquet' (FORMAT PARQUET);
      `);
    });
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns each touched coldkey's net change over only the window, including zero-net ones", async () => {
    const fromSilver = await loadWindowNetDeltasFromSilver(10, 20);

    expect(Object.fromEntries(fromSilver)).toEqual({
      "5Alice": -40n,
      "5Bob": 37n,
      "5Carol": 0n,
      "5Dave": 9n,
    });
    expect(fromSilver).toEqual(netDeltasFromEvents(EVENTS, 10, 20));
  });
});

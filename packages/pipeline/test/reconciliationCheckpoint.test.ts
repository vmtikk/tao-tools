import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asColdkey, asRao } from "@tao-tools/core";
import {
  clearReconciliationCheckpoint,
  decodeKnownGoodBalances,
  encodeKnownGoodBalances,
  readReconciliationCheckpoint,
  writeReconciliationCheckpoint,
} from "../src/chain/reconciliationCheckpoint.js";
import { metaDir } from "../src/paths.js";

const ALICE = asColdkey("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");

describe("reconciliationCheckpoint", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-reconciliation-checkpoint-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns null when no checkpoint exists yet", () => {
    expect(readReconciliationCheckpoint(1, 216_000)).toBeNull();
  });

  it("round-trips a written checkpoint, including a large Rao value JSON can't represent as a number", () => {
    const huge = 9_007_199_254_740_993n; // one past Number.MAX_SAFE_INTEGER
    writeReconciliationCheckpoint({
      fromBlock: 1,
      intervalBlocks: 216_000,
      lastCompletedWindowEnd: 216_000,
      knownGoodBalances: [[ALICE, huge.toString()]],
      totalMismatches: 0,
      updatedAtMs: 12345,
    });

    const read = readReconciliationCheckpoint(1, 216_000);
    expect(read).not.toBeNull();
    expect(read!.lastCompletedWindowEnd).toBe(216_000);
    const balances = decodeKnownGoodBalances(read!.knownGoodBalances);
    expect(balances.get(ALICE)).toBe(huge);
  });

  it("refuses to resume a checkpoint written for a different fromBlock or intervalBlocks", () => {
    writeReconciliationCheckpoint({
      fromBlock: 1,
      intervalBlocks: 216_000,
      lastCompletedWindowEnd: 216_000,
      knownGoodBalances: [],
      totalMismatches: 0,
      updatedAtMs: 1,
    });

    expect(readReconciliationCheckpoint(2, 216_000)).toBeNull(); // different fromBlock
    expect(readReconciliationCheckpoint(1, 100_000)).toBeNull(); // different window size
    expect(readReconciliationCheckpoint(1, 216_000)).not.toBeNull(); // exact match still resumes
  });

  it("treats an unreadable (e.g. NUL-corrupted) checkpoint as no checkpoint rather than throwing", () => {
    mkdirSync(metaDir(), { recursive: true });
    writeFileSync(`${metaDir()}/reconciliation_checkpoint.json`, "\0".repeat(40), "utf-8");
    expect(readReconciliationCheckpoint(1, 216_000)).toBeNull();
  });

  it("clearReconciliationCheckpoint removes it", () => {
    writeReconciliationCheckpoint({
      fromBlock: 1,
      intervalBlocks: 216_000,
      lastCompletedWindowEnd: 216_000,
      knownGoodBalances: [],
      totalMismatches: 0,
      updatedAtMs: 1,
    });
    clearReconciliationCheckpoint();
    expect(readReconciliationCheckpoint(1, 216_000)).toBeNull();
  });

  it("encode/decode round-trips a BalanceMap exactly", () => {
    const original = new Map([
      [ALICE, asRao(0n)],
      [asColdkey("5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"), asRao(9_007_199_254_740_993n)],
    ]);
    const decoded = decodeKnownGoodBalances(encodeKnownGoodBalances(original));
    expect(decoded).toEqual(original);
  });
});

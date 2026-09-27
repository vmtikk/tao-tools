import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCheckpoint, readCheckpoint, readCheckpointToBlock, readRawCheckpoint, writeCheckpoint } from "../src/chain/backfillCheckpoint.js";

describe("backfillCheckpoint", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-checkpoint-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns null when no checkpoint file exists", () => {
    expect(readCheckpoint(1, 1000)).toBeNull();
  });

  it("round-trips a written checkpoint for the matching range", () => {
    writeCheckpoint({ fromBlock: 1, toBlock: 1000, lastCompletedBlock: 500, updatedAtMs: 12345 });
    expect(readCheckpoint(1, 1000)).toEqual({
      fromBlock: 1,
      toBlock: 1000,
      lastCompletedBlock: 500,
      updatedAtMs: 12345,
    });
  });

  it("ignores a checkpoint written for a different range", () => {
    writeCheckpoint({ fromBlock: 1, toBlock: 1000, lastCompletedBlock: 500, updatedAtMs: 1 });
    expect(readCheckpoint(1, 2000)).toBeNull();
    expect(readCheckpoint(2, 1000)).toBeNull();
  });

  it("overwrites the previous checkpoint on each write", () => {
    writeCheckpoint({ fromBlock: 1, toBlock: 1000, lastCompletedBlock: 100, updatedAtMs: 1 });
    writeCheckpoint({ fromBlock: 1, toBlock: 1000, lastCompletedBlock: 200, updatedAtMs: 2 });
    expect(readCheckpoint(1, 1000)?.lastCompletedBlock).toBe(200);
  });

  it("clearCheckpoint removes it", () => {
    writeCheckpoint({ fromBlock: 1, toBlock: 1000, lastCompletedBlock: 100, updatedAtMs: 1 });
    clearCheckpoint();
    expect(readCheckpoint(1, 1000)).toBeNull();
  });

  it("clearCheckpoint on a missing file is a no-op", () => {
    expect(() => clearCheckpoint()).not.toThrow();
  });

  describe("readCheckpointToBlock", () => {
    it("returns null when no checkpoint exists", () => {
      expect(readCheckpointToBlock(1)).toBeNull();
    });

    it("returns the pinned toBlock for a matching fromBlock, ignoring any toBlock the caller has in mind", () => {
      writeCheckpoint({ fromBlock: 1, toBlock: 8_900_000, lastCompletedBlock: 500_000, updatedAtMs: 1 });
      // Simulates a restart where the live chain head has moved on —
      // readCheckpointToBlock must still return the originally pinned value.
      expect(readCheckpointToBlock(1)).toBe(8_900_000);
    });

    it("returns null for a different fromBlock", () => {
      writeCheckpoint({ fromBlock: 1, toBlock: 8_900_000, lastCompletedBlock: 500_000, updatedAtMs: 1 });
      expect(readCheckpointToBlock(2)).toBeNull();
    });
  });

  describe("readRawCheckpoint", () => {
    it("returns null when no checkpoint exists", () => {
      expect(readRawCheckpoint()).toBeNull();
    });

    it("returns whatever is on disk, unfiltered by range", () => {
      writeCheckpoint({ fromBlock: 1, toBlock: 8_900_000, lastCompletedBlock: 500_000, updatedAtMs: 1 });
      expect(readRawCheckpoint()).toEqual({
        fromBlock: 1,
        toBlock: 8_900_000,
        lastCompletedBlock: 500_000,
        updatedAtMs: 1,
      });
    });
  });
});

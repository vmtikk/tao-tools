import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { appendRuntimeVersions } from "../src/chain/runtimeVersionsLog.js";

describe("appendRuntimeVersions (integration — DuckDB append-via-union)", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-runtime-versions-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("does nothing for an empty segment list", async () => {
    const result = await appendRuntimeVersions([]);
    expect(result.rowCount).toBe(0);
  });

  it("creates the file on first write and appends on the second", async () => {
    const first = await appendRuntimeVersions([{ fromBlock: 1, toBlock: 999, specVersion: 101 }]);
    expect(first.rowCount).toBe(1);

    const second = await appendRuntimeVersions([
      { fromBlock: 1000, toBlock: 5000, specVersion: 101 },
      { fromBlock: 5001, toBlock: 9000, specVersion: 102 },
    ]);
    expect(second.rowCount).toBe(3);
    expect(second.destination).toBe(first.destination);

    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const result = await connection.run(
        `SELECT from_block, to_block, spec_version FROM read_parquet('${second.destination.replace(/\\/g, "/")}') ORDER BY from_block;`,
      );
      const rows = await result.getRows();
      expect(rows.map((r) => [Number(r[0]), Number(r[1]), Number(r[2])])).toEqual([
        [1, 999, 101],
        [1000, 5000, 101],
        [5001, 9000, 102],
      ]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});

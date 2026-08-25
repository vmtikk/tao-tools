import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asUnixMillis } from "@tao-tools/core";
import { appendIngestionLog, gapsToLogEntries } from "../src/log/ingestionLog.js";
import { DuckDBInstance } from "@duckdb/node-api";

describe("gapsToLogEntries (unit)", () => {
  const runAt = asUnixMillis(1_000_000);

  it("logs a single clean-run row when there are no gaps", () => {
    const entries = gapsToLogEntries("kraken", "TAOUSD", runAt, 1440, []);
    expect(entries).toEqual([
      { exchange: "kraken", pair: "TAOUSD", runAtMs: runAt, rowsFetched: 1440, gapStartMs: null, gapEndMs: null, missingBuckets: 0 },
    ]);
  });

  it("logs one row per gap", () => {
    const gaps = [
      { startMs: asUnixMillis(10), endMs: asUnixMillis(20), missingBuckets: 2 },
      { startMs: asUnixMillis(50), endMs: asUnixMillis(50), missingBuckets: 1 },
    ];
    const entries = gapsToLogEntries("kraken", "TAOUSD", runAt, 1000, gaps);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ gapStartMs: asUnixMillis(10), gapEndMs: asUnixMillis(20), missingBuckets: 2 });
    expect(entries[1]).toMatchObject({ gapStartMs: asUnixMillis(50), gapEndMs: asUnixMillis(50), missingBuckets: 1 });
  });
});

describe("appendIngestionLog (integration — DuckDB append-via-union)", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-ingestion-log-"));
    prevDataRoot = process.env.DATA_ROOT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("does nothing for an empty entry list", async () => {
    const result = await appendIngestionLog([]);
    expect(result.rowCount).toBe(0);
  });

  it("creates the file on first write and appends on the second", async () => {
    const first = await appendIngestionLog(gapsToLogEntries("kraken", "TAOUSD", asUnixMillis(1), 10, []));
    expect(first.rowCount).toBe(1);

    const second = await appendIngestionLog(gapsToLogEntries("coinbase", "TAOUSD", asUnixMillis(2), 20, []));
    expect(second.rowCount).toBe(2);
    expect(second.destination).toBe(first.destination);

    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const result = await connection.run(
        `SELECT exchange FROM read_parquet('${second.destination.replace(/\\/g, "/")}') ORDER BY run_at_ms;`,
      );
      const rows = await result.getRows();
      expect(rows.map((r) => String(r[0]))).toEqual(["kraken", "coinbase"]);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});

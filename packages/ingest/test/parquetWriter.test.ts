import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { writeRowsAsParquet } from "../src/bronze/parquetWriter.js";

describe("writeRowsAsParquet", () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-parquet-writer-"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  async function readBack(destination: string): Promise<unknown[][]> {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      const result = await connection.run(`SELECT * FROM read_parquet('${destination.replace(/\\/g, "/")}') ORDER BY id;`);
      return result.getRows();
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  it("round-trips simple rows, including bigint fields", async () => {
    const destination = join(tempRoot, "simple.parquet").replace(/\\/g, "/");
    const result = await writeRowsAsParquet({
      rows: [
        { id: 1, label: "a", amount: 100n },
        { id: 2, label: "b", amount: 200n },
      ],
      destination,
    });

    expect(result.rowCount).toBe(2);
    const rows = await readBack(destination);
    // `id` round-trips as DuckDB's inferred BIGINT; `amount` was serialized
    // through the bigint->string replacer (same as the pre-existing
    // behavior this replaced), so it comes back as VARCHAR, not a number.
    expect(rows).toEqual([
      [1n, "a", "100"],
      [2n, "b", "200"],
    ]);
  });

  it("does nothing destructive for an empty row list", async () => {
    const destination = join(tempRoot, "empty.parquet").replace(/\\/g, "/");
    const result = await writeRowsAsParquet({ rows: [], destination });
    expect(result.rowCount).toBe(0);
  });

  /**
   * Regression test for the real 2026-08-26 failure (see parquetWriter.ts's
   * doc comment): the old implementation built one JS string via
   * `rows.map(...).join("\n")` before writing it, which threw
   * `RangeError: Invalid string length` once the combined NDJSON approached
   * V8's ~512MB-1GB single-string ceiling. This uses a smaller multiple
   * (~100MB combined) to stay fast in CI while still exercising a payload
   * an order of magnitude past what any single JSON.stringify call here
   * produces, proving the write is genuinely incremental rather than
   * accumulating rows into one string before writing.
   */
  it("writes a payload much larger than any single row without building one giant string", async () => {
    const bigField = "a".repeat(100_000); // ~100KB per row
    const rowCount = 1000; // ~100MB combined NDJSON
    const rows = Array.from({ length: rowCount }, (_, i) => ({ id: i, blob: bigField }));

    const destination = join(tempRoot, "large.parquet").replace(/\\/g, "/");
    const result = await writeRowsAsParquet({ rows, destination });

    expect(result.rowCount).toBe(rowCount);
    const readRows = await readBack(destination);
    expect(readRows).toHaveLength(rowCount);
    expect(readRows[0]![1]).toBe(bigField);
    expect(readRows[rowCount - 1]![1]).toBe(bigField);
  }, 30_000);

  /**
   * Regression test for a real 2026-08-26 leak (parquetWriter.ts's cleanup
   * comment): a failure during the streaming write itself (there, a genuine
   * `ENOSPC`; here, a row that can't be serialized) used to leave the
   * staging file behind forever, because cleanup only lived in a `finally`
   * around the later DuckDB step. Counts temp-dir entries before/after
   * rather than tracking the exact staging filename, since that name is
   * internal (`randomUUID()`-generated, not returned to the caller).
   */
  it("does not leak the staging file when the write itself fails", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("tao-bronze-stage-"));

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const destination = join(tempRoot, "never-written.parquet").replace(/\\/g, "/");
    await expect(writeRowsAsParquet({ rows: [circular], destination })).rejects.toThrow();

    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("tao-bronze-stage-"));
    expect(after).toEqual(before);
    expect(existsSync(destination)).toBe(false);
  });
});

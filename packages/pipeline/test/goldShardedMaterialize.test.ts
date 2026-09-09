import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { MetricEntry } from "@tao-tools/core";
import { withDuckDb } from "../src/duckdb/session.js";
import { materializeGold, shardFingerprint } from "../src/gold/materialize.js";
import { readGoldShardCheckpoint, writeGoldShardCheckpoint } from "../src/gold/shardCheckpoint.js";

const REAL_REGISTRY_PATH = join(import.meta.dirname, "..", "..", "..", "data", "meta", "metrics_registry.yaml");

/**
 * Covers the `shard_by` path added 2026-09-09. account_balances_daily's
 * single-pass form sorted ~440M delta rows at once, which on this machine
 * meant hours of external sort, ~186GB of spill, and two outright temp-dir
 * exhaustion failures — with no usable progress signal and no way to resume
 * after a shutdown. Sharding fixes all three, but only if a sharded run is
 * *exactly* as correct as the single-pass one, which is what these assert.
 */
describe("sharded gold materialization", () => {
  let tempRoot: string;
  let prevDataRoot: string | undefined;
  let prevShardCount: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "tao-gold-shard-"));
    prevDataRoot = process.env.DATA_ROOT;
    prevShardCount = process.env.GOLD_SHARD_COUNT;
    process.env.DATA_ROOT = join(tempRoot, "data");
  });

  afterEach(() => {
    process.env.DATA_ROOT = prevDataRoot;
    if (prevShardCount === undefined) delete process.env.GOLD_SHARD_COUNT;
    else process.env.GOLD_SHARD_COUNT = prevShardCount;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function dataPath(...segments: string[]): string {
    return join(tempRoot, "data", ...segments).replace(/\\/g, "/");
  }

  /** The real account_balances_daily entry, so these test the shipped SQL. */
  function accountBalancesEntry(): MetricEntry {
    const entries = parse(readFileSync(REAL_REGISTRY_PATH, "utf-8")) as MetricEntry[];
    const entry = entries.find((e) => e.name === "account_balances_daily");
    if (!entry) throw new Error('registry has no "account_balances_daily" entry');
    return entry;
  }

  /** Writes a one-entry registry, optionally with `shard_by` stripped. */
  function writeRegistry(entry: MetricEntry, opts: { sharded: boolean }): string {
    const copy = { ...entry };
    if (!opts.sharded) delete (copy as { shard_by?: string }).shard_by;
    const path = join(tempRoot, `registry-${opts.sharded ? "sharded" : "single"}.yaml`);
    writeFileSync(path, stringify([copy]), "utf-8");
    return path;
  }

  /**
   * Enough distinct coldkeys that hash-bucketing genuinely splits them, and
   * enough per-coldkey history across days that a shard which only saw part
   * of a coldkey's events would produce a visibly wrong running balance.
   * Senders and receivers are drawn from different-sized pools so plenty of
   * transfers straddle two shards — the case the narrowed-view `OR` exists for.
   */
  async function writeSilverFixture(): Promise<void> {
    mkdirSync(dataPath("silver"), { recursive: true });
    await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE transfers AS
        SELECT
          i::BIGINT AS block_number,
          0::INTEGER AS event_index,
          (1770000000000 + i * 3600000)::BIGINT AS timestamp_ms,
          ('5Sender' || (i % 37)) AS from_coldkey,
          ('5Recv' || (i % 23)) AS to_coldkey,
          (((i % 7) + 1) * 1000000)::BIGINT AS amount_rao
        FROM generate_series(1, 400) AS t(i);
      `);
      await connection.run(`COPY transfers TO '${dataPath("silver", "transfers.parquet")}' (FORMAT PARQUET);`);

      await connection.run(`
        CREATE TABLE balance_events AS
        SELECT
          i::BIGINT AS block_number,
          1::INTEGER AS event_index,
          (1770000000000 + i * 3600000)::BIGINT AS timestamp_ms,
          (CASE WHEN i % 2 = 0 THEN 'deposit' ELSE 'withdraw' END) AS kind,
          ('5Sender' || (i % 37)) AS coldkey,
          (((i % 5) + 1) * 2000000)::BIGINT AS amount_rao
        FROM generate_series(1, 400) AS t(i);
      `);
      await connection.run(
        `COPY balance_events TO '${dataPath("silver", "balance_events.parquet")}' (FORMAT PARQUET);`,
      );

      // materializeGold always wires a silver_ohlcv_1m view, so the file has to
      // exist even though this metric never reads it.
      await connection.run(`
        CREATE TABLE ohlcv (
          venue VARCHAR, pair VARCHAR, timestamp_ms BIGINT,
          open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE
        );
      `);
      await connection.run(`COPY ohlcv TO '${dataPath("silver", "ohlcv_1m.parquet")}' (FORMAT PARQUET);`);
    });
  }

  async function readGold(): Promise<Array<[string, number, number]>> {
    return withDuckDb(async (connection) => {
      const result = await connection.run(
        `SELECT coldkey, timestamp_ms, balance_rao
         FROM read_parquet('${dataPath("gold", "account_balances_daily.parquet")}')
         ORDER BY coldkey, timestamp_ms;`,
      );
      const rows = await result.getRows();
      return rows.map((r) => [String(r[0]), Number(r[1]), Number(r[2])] as [string, number, number]);
    });
  }

  it("produces byte-for-byte the same rows as the single-pass query", async () => {
    await writeSilverFixture();
    const entry = accountBalancesEntry();

    await materializeGold(writeRegistry(entry, { sharded: false }));
    const singlePass = await readGold();

    rmSync(dataPath("gold"), { recursive: true, force: true });

    process.env.GOLD_SHARD_COUNT = "8";
    await materializeGold(writeRegistry(entry, { sharded: true }));
    const sharded = await readGold();

    expect(sharded).toEqual(singlePass);
    // Guards against the comparison passing because both sides are empty.
    expect(singlePass.length).toBeGreaterThan(50);
  });

  it("agrees across shard counts, including bucket counts that split differently", async () => {
    await writeSilverFixture();
    const entry = accountBalancesEntry();
    const shardedRegistry = writeRegistry(entry, { sharded: true });

    const byShardCount: Record<string, Array<[string, number, number]>> = {};
    for (const count of ["1", "3", "16"]) {
      rmSync(dataPath("gold"), { recursive: true, force: true });
      process.env.GOLD_SHARD_COUNT = count;
      await materializeGold(shardedRegistry);
      byShardCount[count] = await readGold();
    }

    expect(byShardCount["3"]).toEqual(byShardCount["1"]);
    expect(byShardCount["16"]).toEqual(byShardCount["1"]);
  });

  it("clears its checkpoint and part files once the metric is assembled", async () => {
    await writeSilverFixture();
    process.env.GOLD_SHARD_COUNT = "4";
    await materializeGold(writeRegistry(accountBalancesEntry(), { sharded: true }));

    expect(readGoldShardCheckpoint("account_balances_daily")).toBeNull();
    expect(existsSync(dataPath("gold", "account_balances_daily.parts"))).toBe(false);
    expect(existsSync(dataPath("gold", "account_balances_daily.parquet"))).toBe(true);
  });

  it("recomputes shards a checkpoint claims are done when their part files are missing", async () => {
    await writeSilverFixture();
    const entry = accountBalancesEntry();
    const registry = writeRegistry(entry, { sharded: true });

    process.env.GOLD_SHARD_COUNT = "4";
    await materializeGold(registry);
    const expected = await readGold();
    rmSync(dataPath("gold"), { recursive: true, force: true });

    // A checkpoint that matches the current inputs exactly, claiming every
    // shard is finished, but with no part files behind it — the drift that bit
    // materializeChainSilver for real. Trusting it would skip every shard and
    // assemble nothing.
    writeGoldShardCheckpoint({
      metric: "account_balances_daily",
      shardCount: 4,
      fingerprint: shardFingerprint(entry, 4),
      completedShards: [0, 1, 2, 3],
      updatedAtMs: Date.now(),
    });

    await materializeGold(registry);
    expect(await readGold()).toEqual(expected);
  });

  it("ignores a checkpoint written against different inputs", async () => {
    await writeSilverFixture();
    const registry = writeRegistry(accountBalancesEntry(), { sharded: true });

    process.env.GOLD_SHARD_COUNT = "4";
    await materializeGold(registry);
    const expected = await readGold();
    rmSync(dataPath("gold"), { recursive: true, force: true });

    writeGoldShardCheckpoint({
      metric: "account_balances_daily",
      shardCount: 4,
      fingerprint: "fingerprint-from-some-older-silver",
      completedShards: [0, 1, 2, 3],
      updatedAtMs: Date.now(),
    });

    await materializeGold(registry);
    expect(await readGold()).toEqual(expected);
  });

  /**
   * `pipeline:materialize` rewrites silver/ohlcv_1m.parquet on every run
   * before gold materialization starts. account_balances_daily never reads it,
   * so it must not affect that metric's fingerprint — when it did (caught
   * during the first real sharded run, 2026-09-09), every resume saw a
   * changed fingerprint, discarded the checkpoint, and recomputed all 64
   * shards, which is strictly worse than having no checkpoint at all.
   */
  it("keeps a stable fingerprint when a silver file the metric never reads is rewritten", async () => {
    await writeSilverFixture();
    const entry = accountBalancesEntry();
    const before = shardFingerprint(entry, 64);

    await withDuckDb(async (connection) => {
      await connection.run(`CREATE TABLE ohlcv2 (venue VARCHAR, pair VARCHAR, timestamp_ms BIGINT);`);
      await connection.run(`INSERT INTO ohlcv2 VALUES ('kraken', 'TAO/USD', 1770000000000);`);
      await connection.run(`COPY ohlcv2 TO '${dataPath("silver", "ohlcv_1m.parquet")}' (FORMAT PARQUET);`);
    });

    expect(shardFingerprint(entry, 64)).toBe(before);
  });

  it("changes fingerprint when a silver file the metric does read is rewritten", async () => {
    await writeSilverFixture();
    const entry = accountBalancesEntry();
    const before = shardFingerprint(entry, 64);

    await withDuckDb(async (connection) => {
      await connection.run(`
        CREATE TABLE transfers2 (
          block_number BIGINT, event_index INTEGER, timestamp_ms BIGINT,
          from_coldkey VARCHAR, to_coldkey VARCHAR, amount_rao BIGINT
        );
      `);
      await connection.run(`INSERT INTO transfers2 VALUES (1, 0, 1770000000000, '5A', '5B', 1000);`);
      await connection.run(`COPY transfers2 TO '${dataPath("silver", "transfers.parquet")}' (FORMAT PARQUET);`);
    });

    expect(shardFingerprint(entry, 64)).not.toBe(before);
  });

  /**
   * The exact artifact a hard power-off produced on materializeSilver's
   * checkpoint 2026-09-08: the file was the right length but all NUL bytes,
   * because the rename landed while the written bytes hadn't been flushed.
   * The reader there threw on it, which would abort a run that could
   * perfectly well have continued.
   */
  it("treats an unreadable checkpoint as no checkpoint rather than throwing", async () => {
    mkdirSync(dataPath("meta"), { recursive: true });
    writeFileSync(dataPath("meta", "gold_shard_checkpoint_account_balances_daily.json"), "\0".repeat(88), "utf-8");

    expect(() => readGoldShardCheckpoint("account_balances_daily")).not.toThrow();
    expect(readGoldShardCheckpoint("account_balances_daily")).toBeNull();

    await writeSilverFixture();
    process.env.GOLD_SHARD_COUNT = "4";
    await materializeGold(writeRegistry(accountBalancesEntry(), { sharded: true }));
    expect((await readGold()).length).toBeGreaterThan(50);
  });
});

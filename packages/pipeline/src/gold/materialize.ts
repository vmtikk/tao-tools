import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import type { MetricEntry } from "@tao-tools/core";
import { withDuckDb } from "../duckdb/session.js";
import { goldDir, metaDir, silverDir } from "../paths.js";
import { loadRegistry } from "../registry/loader.js";
import { goldFileForMetric } from "../registry/goldFiles.js";
import {
  clearGoldShardCheckpoint,
  readGoldShardCheckpoint,
  writeGoldShardCheckpoint,
} from "./shardCheckpoint.js";

export interface MaterializeGoldResult {
  metric: string;
  destination: string;
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

const DEFAULT_SHARD_COUNT = 64;

function resolveShardCount(): number {
  const raw = process.env.GOLD_SHARD_COUNT;
  if (!raw) return DEFAULT_SHARD_COUNT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`GOLD_SHARD_COUNT must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * Which columns of each runner-owned silver view carry a given shard key.
 *
 * Narrowing the inputs is a speed optimization, not what makes sharding
 * correct — correctness comes from filtering the metric's *output* to the
 * shard. That asymmetry is the thing to keep in mind when editing this: a
 * narrowing predicate that is too wide only costs time, while one that is too
 * narrow silently drops events from a coldkey's history and corrupts its
 * running balance. Hence `silver_transfers` matching on *either* leg — a
 * transfer's two coldkeys can land in different shards, and the shard that
 * owns either one needs the whole row.
 */
const SILVER_SHARD_KEY_COLUMNS: Record<string, Record<string, string[]>> = {
  coldkey: {
    silver_transfers: ["from_coldkey", "to_coldkey"],
    silver_balance_events: ["coldkey"],
  },
};

interface ShardSpec {
  column: string;
  index: number;
  count: number;
}

/**
 * The silver parquet file behind each view this module wires up, used to
 * fingerprint only the inputs a given metric actually reads.
 */
const SILVER_VIEW_FILES: Record<string, string> = {
  silver_transfers: "transfers.parquet",
  silver_balance_events: "balance_events.parquet",
  silver_ohlcv_1m: "ohlcv_1m.parquet",
};

/**
 * COALESCE keeps a NULL key from vanishing: `hash(NULL)` is NULL, and
 * `NULL % n = k` is NULL rather than false, so an un-COALESCE'd key would be
 * excluded from *every* shard instead of landing in exactly one — a silent
 * row loss versus the unsharded query, which happily gives NULL its own
 * partition.
 */
function shardExpr(column: string, count: number): string {
  return `hash(COALESCE(CAST(${column} AS VARCHAR), '')) % ${count}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/**
 * Identifies the inputs and definition a set of shard parts was built from, so
 * a checkpoint is only resumed against the exact same ones. Covers the metric's
 * own version and SQL plus the size and mtime of the silver files it reads —
 * re-materializing silver, or editing the metric mid-run, has to invalidate
 * finished parts rather than let two generations of data end up in one file.
 *
 * Only the files the entry's SQL actually references, which matters more than
 * it looks: `pipeline:materialize` rewrites silver/ohlcv_1m.parquet on every
 * single invocation (materializeSilverOhlcv runs before materializeGold), so
 * fingerprinting the whole silver directory would give that file a fresh mtime
 * every run and invalidate the checkpoint every time — resumability that never
 * once resumes. Found while watching the first real sharded run 2026-09-09.
 */
export function shardFingerprint(entry: MetricEntry, shardCount: number): string {
  const parts = [
    `metric=${entry.name}`,
    `version=${entry.version}`,
    `shards=${shardCount}`,
    `sql=${createHash("sha256").update(entry.sql).digest("hex").slice(0, 16)}`,
  ];
  for (const [view, file] of Object.entries(SILVER_VIEW_FILES).sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry.sql.includes(view)) continue;
    const path = `${silverDir()}/${file}`;
    if (!existsSync(path)) {
      parts.push(`${file}:absent`);
      continue;
    }
    const stat = statSync(path);
    parts.push(`${file}:${stat.size}:${Math.round(stat.mtimeMs)}`);
  }
  return parts.join("|");
}

/**
 * Runs each registry entry's SQL (in dependency order) against silver and
 * previously-materialized gold, writing one Parquet file per metric
 * (tao-analytics-plan.md §8). Registry SQL is verbatim — no templating of
 * the metric logic itself, only the view wiring around it.
 *
 * An entry with `shard_by` set is computed one hash-bucket of that column at
 * a time (see materializeShardedEntry); everything else runs as a single
 * statement.
 */
export async function materializeGold(registryPath?: string): Promise<MaterializeGoldResult[]> {
  const entries = loadRegistry(registryPath);
  mkdirSync(goldDir(), { recursive: true });
  const results: MaterializeGoldResult[] = [];
  const shardCount = resolveShardCount();

  await withDuckDb(
    async (connection) => {
      // Found for real (2026-09-08): account_balances_daily's windowed running
      // sum + the final ORDER BY, run against the full ~8.9M-block chain
      // history (~440M rows in the deltas CTE), exhausted a 19.2GiB temp
      // spill directory (all the free disk this machine had) even with
      // memory_limit capped at 3GB. Both settings are DuckDB's own suggested
      // fix for exactly this shape of OOM (large parallel sort/window +
      // COPY): preserve_insertion_order is safe to disable because the
      // query's own explicit ORDER BY already fixes the output order,
      // independent of how parallel workers finish; fewer threads means
      // fewer simultaneous large sort buffers, trading some wall-clock time
      // for a much smaller peak working set on a 12-core/14GB machine.
      await connection.run("SET preserve_insertion_order=false;");
      await connection.run("SET threads=4;");

      await connection.run(
        `CREATE OR REPLACE VIEW silver_ohlcv_1m AS
         SELECT * FROM read_parquet('${escapeSqlLiteral(silverDir())}/ohlcv_1m.parquet');`,
      );

      /**
       * (Re)creates the chain silver views. With a `shard` they're narrowed to
       * rows touching that shard's keys, which is what keeps a sharded metric's
       * per-pass working set small enough to stay in memory; with null they're
       * the full unfiltered views every other entry expects. Called again with
       * null once a sharded entry finishes, so later entries in the loop never
       * inherit a narrowed view.
       */
      const createChainSilverViews = async (shard: ShardSpec | null): Promise<void> => {
        const narrowing = shard ? SILVER_SHARD_KEY_COLUMNS[shard.column] : undefined;
        if (shard && !narrowing) {
          throw new Error(
            `No silver shard-key columns registered for shard_by "${shard.column}" — ` +
              "add them to SILVER_SHARD_KEY_COLUMNS, or every shard will rescan all of silver.",
          );
        }
        const whereFor = (view: string): string => {
          const columns = narrowing?.[view];
          if (!columns || !shard) return "";
          const predicate = columns
            .map((column) => `${shardExpr(column, shard.count)} = ${shard.index}`)
            .join(" OR ");
          return ` WHERE ${predicate}`;
        };

        // Only created when chain silver exists — a Phase 1-only environment (or
        // a test fixture that never ran chain ingestion) has no transfers.parquet
        // yet, and a registry entry that doesn't reference silver_transfers must
        // still materialize normally without it.
        const transfersPath = `${silverDir()}/transfers.parquet`;
        if (existsSync(transfersPath)) {
          await connection.run(
            `CREATE OR REPLACE VIEW silver_transfers AS SELECT * FROM read_parquet('${escapeSqlLiteral(transfersPath)}')${whereFor("silver_transfers")};`,
          );
        }

        // Unlike silver_transfers (only created, and only relied on, when
        // present — Phase-1-only environments simply don't run entries that
        // need it), balance_events gets an empty-but-typed fallback view: a
        // chain silver run that predates balance-event decoding (or a fixture
        // that only ever wrote transfers.parquet, e.g. goldExport.golden.test.ts)
        // still has real transfers, and account_balances_daily (§7.1) needs to
        // fold both sources — "no deposits/withdraws decoded yet" is a valid
        // empty set, not a reason to crash every entry after it in the loop.
        const balanceEventsPath = `${silverDir()}/balance_events.parquet`;
        if (existsSync(balanceEventsPath)) {
          await connection.run(
            `CREATE OR REPLACE VIEW silver_balance_events AS SELECT * FROM read_parquet('${escapeSqlLiteral(balanceEventsPath)}')${whereFor("silver_balance_events")};`,
          );
        } else {
          await connection.run(`
            CREATE OR REPLACE VIEW silver_balance_events AS
            SELECT
              CAST(NULL AS BIGINT) AS block_number,
              CAST(NULL AS INTEGER) AS event_index,
              CAST(NULL AS BIGINT) AS timestamp_ms,
              CAST(NULL AS VARCHAR) AS kind,
              CAST(NULL AS VARCHAR) AS coldkey,
              CAST(NULL AS BIGINT) AS amount_rao
            WHERE FALSE;
          `);
        }
      };

      await createChainSilverViews(null);

      // Optional, same as silver_balance_events above — an environment that
      // hasn't run `trends:backfill` yet is valid, not an error, so any
      // metric reading this still materializes with zero rows instead of
      // crashing every entry after it in the loop.
      const googleTrendsPath = `${silverDir()}/google_trends.parquet`;
      if (existsSync(googleTrendsPath)) {
        await connection.run(
          `CREATE OR REPLACE VIEW silver_google_trends AS
           SELECT * FROM read_parquet('${escapeSqlLiteral(googleTrendsPath)}');`,
        );
      } else {
        await connection.run(`
          CREATE OR REPLACE VIEW silver_google_trends AS
          SELECT
            CAST(NULL AS VARCHAR) AS keyword,
            CAST(NULL AS BIGINT) AS week_start_ms,
            CAST(NULL AS DOUBLE) AS value,
            CAST(NULL AS BOOLEAN) AS is_partial,
            CAST(NULL AS BIGINT) AS fetched_at_ms
          WHERE FALSE;
        `);
      }

      // §7.2's hand-curated coldkey -> exchange label set. Read as a view
      // (not embedded in registry SQL) so relabeling an exchange never needs
      // a metric version bump — only the underlying facts changed, not the
      // definition. Empty-but-typed fallback for the same reason
      // silver_balance_events has one: no labels yet is a valid empty set.
      const exchangeLabelsPath = `${metaDir()}/exchange_labels.json`;
      if (existsSync(exchangeLabelsPath)) {
        await connection.run(
          `CREATE OR REPLACE VIEW exchange_labels AS
           SELECT coldkey, exchange, confidence, date_added, evidence
           FROM read_json_auto('${escapeSqlLiteral(exchangeLabelsPath)}');`,
        );
      } else {
        await connection.run(`
          CREATE OR REPLACE VIEW exchange_labels AS
          SELECT
            CAST(NULL AS VARCHAR) AS coldkey,
            CAST(NULL AS VARCHAR) AS exchange,
            CAST(NULL AS VARCHAR) AS confidence,
            CAST(NULL AS VARCHAR) AS date_added,
            CAST(NULL AS VARCHAR) AS evidence
          WHERE FALSE;
        `);
      }

      for (const entry of entries) {
        for (const dep of entry.depends_on) {
          const depFile = goldFileForMetric(dep);
          await connection.run(
            `CREATE OR REPLACE VIEW ${dep} AS
             SELECT * FROM read_parquet('${escapeSqlLiteral(goldDir())}/${escapeSqlLiteral(depFile)}.parquet');`,
          );
        }

        const destination = `${goldDir()}/${goldFileForMetric(entry.name)}.parquet`;
        const startedAt = Date.now();
        console.log(`Materializing gold metric: ${entry.name}...`);

        if (entry.shard_by) {
          await materializeShardedEntry({
            connection,
            entry,
            shardBy: entry.shard_by,
            shardCount,
            destination,
            createChainSilverViews,
          });
        } else {
          // Found for real (2026-09-08): account_balances_daily's COPY ran for
          // 20+ minutes with zero output, giving no way to tell "still working"
          // from "stuck" short of manually checking disk usage from outside the
          // process. DuckDB tracks query progress internally (rows_processed /
          // total_rows_to_process) even for a single opaque SQL statement like
          // this one — `connection.progress` reads it directly, no need to
          // restructure the query into logged stages. Coarse, and found for
          // real 2026-09-09 to report nothing at all for a big windowed sort
          // (it sat at "no estimate" for hours), which is what `shard_by`
          // exists to fix — but for everything else it beats silence.
          const runPromise = connection.run(
            `COPY (${entry.sql}) TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
          );
          const progressTimer = setInterval(() => {
            const p = connection.progress;
            const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(0);
            if (p.total_rows_to_process > 0n) {
              console.log(
                `  ...${entry.name}: ${p.percentage.toFixed(1)}% (${p.rows_processed}/${p.total_rows_to_process} rows), ${elapsedS}s elapsed`,
              );
            } else {
              console.log(`  ...${entry.name}: still running, ${elapsedS}s elapsed (no progress estimate available yet)`);
            }
          }, 30_000);
          try {
            await runPromise;
          } finally {
            clearInterval(progressTimer);
          }
        }

        // Reading the count back from the parquet file just written (footer
        // metadata only) instead of re-running entry.sql a second time — the
        // old approach paid the full cost of an expensive query (e.g.
        // account_balances_daily's ~440M-row window function) twice for no
        // reason other than getting a row count.
        const countResult = await connection.run(
          `SELECT COUNT(*) AS n FROM read_parquet('${escapeSqlLiteral(destination)}');`,
        );
        const rows = await countResult.getRows();
        results.push({ metric: entry.name, destination, rowCount: Number(rows[0]?.[0] ?? 0) });
        console.log(`  ${entry.name} done in ${formatDuration(Date.now() - startedAt)}.`);
      }
    },
    // See session.ts's memoryLimit doc comment — account_balances_daily (§7.1)
    // sorts/windows over the full chain event index, the same class of
    // unbounded-memory risk reconcileBalances.ts hit for real 2026-09-05.
    { memoryLimit: "3GB" },
  );

  return results;
}

/**
 * Computes one `shard_by` metric a hash-bucket at a time, writing a part file
 * per bucket and checkpointing after each, then concatenating the parts into
 * the metric's real destination.
 *
 * Why this is exact rather than an approximation: every window in a shardable
 * entry's SQL partitions by the shard column, so a bucket's rows are
 * computable without seeing any other bucket's. Each shard runs the entry's
 * SQL *verbatim* against narrowed silver views and then keeps only its own
 * bucket's output rows. The narrowed views are a superset of what the bucket
 * needs (a transfer is visible to both of its legs' shards), so coldkeys in
 * the bucket see their complete history and fold correctly; the counterparty
 * coldkeys that ride along get partial folds and are dropped by the output
 * filter, so every key is emitted by exactly one shard.
 *
 * The parts are concatenated without a global ORDER BY on purpose: re-sorting
 * the combined output would reintroduce the single huge sort this exists to
 * avoid. Rows stay ordered within a part. That's fine for a `shard_by` metric
 * like account_balances_daily, which is an internal base table (export: false)
 * whose consumers all group/window over it rather than relying on file order.
 */
async function materializeShardedEntry(args: {
  connection: Parameters<Parameters<typeof withDuckDb>[0]>[0];
  entry: MetricEntry;
  shardBy: string;
  shardCount: number;
  destination: string;
  createChainSilverViews: (shard: ShardSpec | null) => Promise<void>;
}): Promise<void> {
  const { connection, entry, shardBy, shardCount, destination, createChainSilverViews } = args;

  const partsDir = `${goldDir()}/${goldFileForMetric(entry.name)}.parts`;
  const partPath = (index: number): string => `${partsDir}/part-${String(index).padStart(5, "0")}.parquet`;
  const fingerprint = shardFingerprint(entry, shardCount);

  const checkpoint = readGoldShardCheckpoint(entry.name);
  let completed = new Set<number>();
  if (checkpoint && checkpoint.fingerprint === fingerprint) {
    // Trusting only the shards whose part file is actually on disk. The
    // checkpoint and its artifacts can drift apart — materializeChainSilver hit
    // exactly this (a checkpoint claiming progress its staging DB no longer
    // had), and believing the JSON alone would silently leave those shards'
    // coldkeys out of the assembled output entirely.
    completed = new Set(checkpoint.completedShards.filter((index) => existsSync(partPath(index))));
    const missing = checkpoint.completedShards.length - completed.size;
    if (missing > 0) {
      console.warn(`  ${entry.name}: ${missing} checkpointed shard(s) have no part file on disk — recomputing them.`);
    }
    if (completed.size > 0) {
      console.log(`  ${entry.name}: resuming from checkpoint, ${completed.size}/${shardCount} shards already done.`);
    }
  } else if (checkpoint) {
    console.log(`  ${entry.name}: checkpoint predates the current silver/definition — starting shards over.`);
    rmSync(partsDir, { recursive: true, force: true });
  }
  mkdirSync(partsDir, { recursive: true });

  const runStartedAt = Date.now();
  let completedThisRun = 0;

  for (let index = 0; index < shardCount; index++) {
    if (completed.has(index)) continue;

    await createChainSilverViews({ column: shardBy, index, count: shardCount });
    await connection.run(
      `COPY (
         SELECT * FROM (${entry.sql}) AS shard_source
         WHERE ${shardExpr(shardBy, shardCount)} = ${index}
       ) TO '${escapeSqlLiteral(partPath(index))}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
    );

    completed.add(index);
    completedThisRun++;
    writeGoldShardCheckpoint({
      metric: entry.name,
      shardCount,
      fingerprint,
      completedShards: [...completed].sort((a, b) => a - b),
      updatedAtMs: Date.now(),
    });

    const elapsedMs = Date.now() - runStartedAt;
    const remaining = shardCount - completed.size;
    const etaMs = (elapsedMs / completedThisRun) * remaining;
    console.log(
      `  ${entry.name}: shard ${completed.size}/${shardCount} complete ` +
        `(${((completed.size / shardCount) * 100).toFixed(1)}%), ` +
        `${formatDuration(elapsedMs)} elapsed` +
        (remaining > 0 ? `, ~${formatDuration(etaMs)} remaining` : ""),
    );
  }

  // Back to unfiltered before anything else runs against these views.
  await createChainSilverViews(null);

  console.log(`  ${entry.name}: assembling ${shardCount} shard parts...`);
  await connection.run(
    `COPY (SELECT * FROM read_parquet('${escapeSqlLiteral(partsDir)}/*.parquet'))
     TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
  );

  // Only after the destination is written — an interrupt during assembly
  // leaves the checkpoint and parts intact, so the rerun skips every shard and
  // just redoes the (cheap, streaming) concatenation.
  rmSync(partsDir, { recursive: true, force: true });
  clearGoldShardCheckpoint(entry.name);
}

import { existsSync, mkdirSync } from "node:fs";
import { withDuckDb } from "../duckdb/session.js";
import { goldDir, metaDir, silverDir } from "../paths.js";
import { loadRegistry } from "../registry/loader.js";
import { goldFileForMetric } from "../registry/goldFiles.js";

export interface MaterializeGoldResult {
  metric: string;
  destination: string;
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Runs each registry entry's SQL (in dependency order) against silver and
 * previously-materialized gold, writing one Parquet file per metric
 * (tao-analytics-plan.md §8). Registry SQL is verbatim — no templating of
 * the metric logic itself, only the view wiring around it.
 */
export async function materializeGold(registryPath?: string): Promise<MaterializeGoldResult[]> {
  const entries = loadRegistry(registryPath);
  mkdirSync(goldDir(), { recursive: true });
  const results: MaterializeGoldResult[] = [];

  await withDuckDb(
    async (connection) => {
      await connection.run(
        `CREATE OR REPLACE VIEW silver_ohlcv_1m AS
         SELECT * FROM read_parquet('${escapeSqlLiteral(silverDir())}/ohlcv_1m.parquet');`,
      );

      // Only created when chain silver exists — a Phase 1-only environment (or
      // a test fixture that never ran chain ingestion) has no transfers.parquet
      // yet, and a registry entry that doesn't reference silver_transfers must
      // still materialize normally without it.
      const transfersPath = `${silverDir()}/transfers.parquet`;
      if (existsSync(transfersPath)) {
        await connection.run(
          `CREATE OR REPLACE VIEW silver_transfers AS SELECT * FROM read_parquet('${escapeSqlLiteral(transfersPath)}');`,
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
          `CREATE OR REPLACE VIEW silver_balance_events AS SELECT * FROM read_parquet('${escapeSqlLiteral(balanceEventsPath)}');`,
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
        await connection.run(
          `COPY (${entry.sql}) TO '${escapeSqlLiteral(destination)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
        );

        const countResult = await connection.run(`SELECT COUNT(*) AS n FROM (${entry.sql}) t;`);
        const rows = await countResult.getRows();
        results.push({ metric: entry.name, destination, rowCount: Number(rows[0]?.[0] ?? 0) });
      }
    },
    // See session.ts's memoryLimit doc comment — account_balances_daily (§7.1)
    // sorts/windows over the full chain event index, the same class of
    // unbounded-memory risk reconcileBalances.ts hit for real 2026-09-05.
    { memoryLimit: "3GB" },
  );

  return results;
}

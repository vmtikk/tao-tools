import { existsSync, mkdirSync } from "node:fs";
import { withDuckDb } from "../duckdb/session.js";
import { goldDir, silverDir } from "../paths.js";
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

  await withDuckDb(async (connection) => {
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
  });

  return results;
}

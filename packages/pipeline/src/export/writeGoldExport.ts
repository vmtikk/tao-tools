import { mkdirSync, writeFileSync } from "node:fs";
import { asUnixMillis, type GoldExport, type GoldSeries } from "@tao-tools/core";
import { withDuckDb } from "../duckdb/session.js";
import { exportDir, goldDir } from "../paths.js";
import { loadRegistry } from "../registry/loader.js";
import { goldFileForMetric } from "../registry/goldFiles.js";

export interface WriteGoldExportResult {
  destination: string;
  seriesCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * gold/*.parquet -> export/gold.json (tao-analytics-plan.md §9). This is
 * the only file the deployed site ever reads — no runtime queries, no R2
 * access, no API keys in the frontend.
 */
export async function writeGoldExport(registryPath?: string): Promise<WriteGoldExportResult> {
  const entries = loadRegistry(registryPath);
  const destination = `${exportDir()}/gold.json`;
  mkdirSync(exportDir(), { recursive: true });

  const series: GoldSeries[] = await withDuckDb(async (connection) => {
    const out: GoldSeries[] = [];
    for (const entry of entries) {
      const file = `${goldDir()}/${goldFileForMetric(entry.name)}.parquet`;
      const result = await connection.run(
        `SELECT timestamp_ms, value FROM read_parquet('${escapeSqlLiteral(file)}') ORDER BY timestamp_ms;`,
      );
      const rows = await result.getRows();
      out.push({
        metric: entry.name,
        version: entry.version,
        points: rows.map((row) => ({
          timestampMs: asUnixMillis(Number(row[0])),
          value: Number(row[1]),
        })),
      });
    }
    return out;
  });

  const goldExport: GoldExport = { generatedAt: asUnixMillis(Date.now()), series };
  writeFileSync(destination, JSON.stringify(goldExport, null, 2), "utf-8");
  return { destination, seriesCount: series.length };
}

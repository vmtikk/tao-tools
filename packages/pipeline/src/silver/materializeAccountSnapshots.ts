import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import type { TypeRegistry } from "@polkadot/types";
import { withDuckDb } from "../duckdb/session.js";
import { resolveBronzeUri, silverDir } from "../paths.js";
import { buildRegistry } from "../chain/decodeEvents.js";
import { decodeAccountBalances } from "../chain/decodeAccount.js";

export interface MaterializeSilverAccountSnapshotsResult {
  destination: string;
  rowCount: number;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * bronze/chain/account_snapshots/{block}.parquet (raw System.Account entries,
 * `chain:snapshot-accounts`) -> silver/account_snapshots.parquet, one row per
 * (block_number, coldkey) with free and reserved decoded against that
 * block's runtime metadata.
 *
 * `timestamp_ms` dates each snapshot by the first decoded chain event after
 * its block, taken from chain silver: a snapshot is state *after* its block,
 * and genesis (block 0) has no timestamp of its own. It's null when chain
 * silver isn't built yet; gold ignores such rows.
 *
 * Returns null (writes nothing) when no snapshot bronze exists — optional,
 * same treatment as Google Trends silver.
 */
export async function materializeSilverAccountSnapshots(): Promise<MaterializeSilverAccountSnapshotsResult | null> {
  const bronzeUri = resolveBronzeUri();
  const snapshotGlob = `${bronzeUri}/chain/account_snapshots/*.parquet`;
  const destination = `${silverDir()}/account_snapshots.parquet`;
  mkdirSync(silverDir(), { recursive: true });

  return withDuckDb(
    async (connection) => {
      let rows: unknown[][];
      try {
        rows = await connection
          .run(`SELECT block_number, spec_version, coldkey, account_info_hex FROM read_parquet('${escapeSqlLiteral(snapshotGlob)}');`)
          .then((r) => r.getRows());
      } catch {
        return null; // no snapshot bronze written yet
      }

      const registries = new Map<number, TypeRegistry>();
      for (const spec of new Set(rows.map((row) => Number(row[1])))) {
        const meta = await connection
          .run(`SELECT metadata_hex FROM read_parquet('${escapeSqlLiteral(`${bronzeUri}/chain/metadata/${spec}.parquet`)}') LIMIT 1;`)
          .then((r) => r.getRows());
        if (!meta[0]) throw new Error(`No bronze chain/metadata for spec_version ${spec}`);
        registries.set(spec, buildRegistry(String(meta[0][0])));
      }

      const timestampByBlock = new Map<number, number | null>();
      for (const block of new Set(rows.map((row) => Number(row[0])))) {
        const sources = ["transfers", "balance_events"]
          .map((table) => `${silverDir()}/${table}.parquet`)
          .filter((path) => existsSync(path))
          .map((path) => `SELECT MIN(timestamp_ms) AS t FROM read_parquet('${escapeSqlLiteral(path)}') WHERE block_number > ${block}`);
        const t =
          sources.length === 0
            ? null
            : (await connection.run(`SELECT MIN(t) FROM (${sources.join(" UNION ALL ")});`).then((r) => r.getRows()))[0]?.[0];
        timestampByBlock.set(block, t == null ? null : Number(t));
      }

      await connection.run(
        "CREATE TABLE account_snapshots (block_number BIGINT, timestamp_ms BIGINT, coldkey VARCHAR, free_rao BIGINT, reserved_rao BIGINT);",
      );
      const values = rows.map((row) => {
        const block = Number(row[0]);
        const { free, reserved } = decodeAccountBalances(registries.get(Number(row[1]))!, String(row[3]));
        return `(${block}, ${timestampByBlock.get(block) ?? "NULL"}, '${escapeSqlLiteral(String(row[2]))}', ${free}, ${reserved})`;
      });
      for (let i = 0; i < values.length; i += 5000) {
        await connection.run(`INSERT INTO account_snapshots VALUES ${values.slice(i, i + 5000).join(",")};`);
      }
      // Replace the file only when its contents change: account_balances_daily's
      // shard checkpoint fingerprints silver by size + mtime, so rewriting an
      // identical file every pipeline:materialize would make it never resume.
      const tempPath = `${destination}.tmp`;
      await connection.run(
        `COPY (SELECT * FROM account_snapshots ORDER BY block_number, coldkey)
         TO '${escapeSqlLiteral(tempPath)}' (FORMAT PARQUET, COMPRESSION ZSTD);`,
      );
      if (existsSync(destination) && readFileSync(destination).equals(readFileSync(tempPath))) {
        rmSync(tempPath);
      } else {
        renameSync(tempPath, destination);
      }
      return { destination, rowCount: values.length };
    },
    { needsR2: bronzeUri.startsWith("s3://") },
  );
}

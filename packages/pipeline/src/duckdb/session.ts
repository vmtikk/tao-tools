import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function configureR2Secret(connection: DuckDBConnection): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const keyId = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !keyId || !secret) {
    throw new Error(
      "BRONZE_URI points at s3:// but R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are not set. " +
        "See .env.example.",
    );
  }
  await connection.run("INSTALL httpfs; LOAD httpfs;");
  await connection.run(
    `CREATE OR REPLACE SECRET r2_secret (
       TYPE R2,
       KEY_ID '${escapeSqlLiteral(keyId)}',
       SECRET '${escapeSqlLiteral(secret)}',
       ACCOUNT_ID '${escapeSqlLiteral(accountId)}'
     );`,
  );
}

export interface DuckDbSessionOptions {
  /** Configure the R2 secret before running `fn` — needed when reading s3:// bronze. */
  needsR2?: boolean;
}

/**
 * Opens an in-memory DuckDB connection for the duration of `fn`, then closes
 * it. Silver/gold materialization never keeps a DuckDB server process
 * running (§2 — "no server process").
 */
export async function withDuckDb<T>(
  fn: (connection: DuckDBConnection) => Promise<T>,
  opts: DuckDbSessionOptions = {},
): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    if (opts.needsR2) {
      await configureR2Secret(connection);
    }
    return await fn(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

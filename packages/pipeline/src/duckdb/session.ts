import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { configureR2Secret } from "@tao-tools/ingest";

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

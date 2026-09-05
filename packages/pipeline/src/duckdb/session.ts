import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { configureR2Secret } from "@tao-tools/ingest";

export interface DuckDbSessionOptions {
  /** Configure the R2 secret before running `fn` — needed when reading s3:// bronze. */
  needsR2?: boolean;
  /** Defaults to an in-memory (`:memory:`) database. Pass a file path to
   * persist tables across process runs — used by materializeChainSilver's
   * resumable mode, where decode progress needs to survive a restart. */
  dbPath?: string;
  /**
   * Caps DuckDB's own buffer-manager memory (e.g. `"2GB"`), applied via
   * `SET memory_limit` right after connecting. Left unset, DuckDB
   * auto-sizes against *total* system RAM, which found for real
   * (2026-08-30) is too optimistic on a machine where a lot of that RAM is
   * already committed to other processes — a persistent staging DB that
   * had grown to ~375MB hit "Out of Memory Error: Allocation failure" on
   * open (replaying its WAL) despite gigabytes of nominal headroom, because
   * the *actual* free memory was much smaller than DuckDB's default assumed.
   * An explicit, conservative cap makes DuckDB spill to disk instead of
   * failing — slower, but correct — rather than trusting its own guess.
   */
  memoryLimit?: string;
}

/**
 * Thrown only when opening/connecting to `dbPath` itself fails (corrupt
 * file, unreplayable WAL, locked by another process) — never when `fn`
 * throws after a successful open. Found for real (2026-08-29):
 * materializeChainSilver's resumable mode used to catch *any* error from
 * `withDuckDb` and treat it as "the staging DB is broken, wipe it and
 * restart" — which silently ate a genuine mid-decode error (a real block's
 * event didn't match its stamped spec_version's metadata) as if it were DB
 * corruption, discarding two hours of good progress only to walk straight
 * back into the same real error. Callers that need to tell "DB won't open"
 * apart from "DB opened fine, but my own code failed" must catch this type
 * specifically, not `Error` generally.
 */
export class DuckDbOpenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DuckDbOpenError";
    this.cause = cause;
  }
}

/**
 * Opens a DuckDB connection for the duration of `fn`, then closes it.
 * Silver/gold materialization never keeps a DuckDB server process running
 * (§2 — "no server process") — an on-disk `dbPath` persists *tables*
 * between runs, not a running server.
 */
export async function withDuckDb<T>(
  fn: (connection: DuckDBConnection) => Promise<T>,
  opts: DuckDbSessionOptions = {},
): Promise<T> {
  let instance: DuckDBInstance;
  let connection: DuckDBConnection;
  try {
    instance = await DuckDBInstance.create(opts.dbPath ?? ":memory:");
    connection = await instance.connect();
  } catch (err) {
    throw new DuckDbOpenError(err);
  }
  try {
    if (opts.memoryLimit) {
      await connection.run(`SET memory_limit='${opts.memoryLimit.replace(/'/g, "''")}';`);
    }
    if (opts.needsR2) {
      await configureR2Secret(connection);
    }
    return await fn(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

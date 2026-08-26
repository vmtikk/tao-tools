import type { RawBlockRecord } from "./fetchBlockRange.js";
import { resolveBronzeUri } from "../paths.js";
import { writeRowsAsParquet, type WriteRowsAsParquetResult } from "../bronze/parquetWriter.js";

function zeroPadBlock(n: number): string {
  return String(n).padStart(9, "0");
}

export interface WriteChainEventsBronzeOptions {
  records: readonly RawBlockRecord[];
  fromBlock: number;
  toBlock: number;
  /** Stamped on every row (tao-analytics-plan.md §10: "Stamp every row with
   * block number, timestamp, and runtime version.") — assumed constant across
   * the range, which only holds for a window that doesn't cross a runtime
   * upgrade. Fine for the Phase 2.1/2.2 tracer bullet (1,000 blocks at chain
   * start); the full genesis backfill (2.3) must detect upgrades per-range
   * instead of trusting one value for the whole pull. */
  specVersion: number;
  bronzeUri?: string;
}

/** bronze/chain/events/{fromBlock}-{toBlock}.parquet — one row per block,
 * raw hex, undecoded (§4.2: "No decoding happens during ingestion"). */
export async function writeChainEventsBronze(opts: WriteChainEventsBronzeOptions): Promise<WriteRowsAsParquetResult> {
  const bronzeUri = (opts.bronzeUri ?? resolveBronzeUri()).replace(/\/+$/, "");
  const destination = `${bronzeUri}/chain/events/${zeroPadBlock(opts.fromBlock)}-${zeroPadBlock(opts.toBlock)}.parquet`;
  const rows = opts.records.map((r) => ({
    block_number: r.blockNumber,
    block_hash: r.blockHash,
    events_hex: r.eventsHex,
    timestamp_hex: r.timestampHex,
    spec_version: opts.specVersion,
  }));
  return writeRowsAsParquet({ rows, destination });
}

export interface WriteChainMetadataBronzeOptions {
  specVersion: number;
  metadataHex: string;
  /** Which block this metadata was fetched at — not part of the key (the
   * layout is one row per spec_version, §2), but useful provenance. */
  capturedAtBlock: number;
  bronzeUri?: string;
}

/** bronze/chain/metadata/{spec_version}.parquet — one row per runtime
 * upgrade (§2 layout), cached so silver decoding never re-fetches metadata. */
export async function writeChainMetadataBronze(
  opts: WriteChainMetadataBronzeOptions,
): Promise<WriteRowsAsParquetResult> {
  const bronzeUri = (opts.bronzeUri ?? resolveBronzeUri()).replace(/\/+$/, "");
  const destination = `${bronzeUri}/chain/metadata/${opts.specVersion}.parquet`;
  const rows = [
    { spec_version: opts.specVersion, metadata_hex: opts.metadataHex, captured_at_block: opts.capturedAtBlock },
  ];
  return writeRowsAsParquet({ rows, destination });
}

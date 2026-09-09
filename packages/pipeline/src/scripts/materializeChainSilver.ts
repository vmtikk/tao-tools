import { materializeChainSilver } from "../chain/materializeChainSilver.js";

/**
 * Found for real (2026-08-30): per-block `events_hex` size grows sharply
 * deeper into chain history — average 5.2KB/block around block 100,000 vs.
 * 36.4KB/block (max 350KB!) around block 2,800,000, a ~7x increase, with
 * more history (more subnets, more activity) still to come. The default
 * `BATCH_BLOCKS=20,000` was sized against early, sparse history; at 2.8M's
 * density a single batch pulls ~730MB of raw hex text before decoding even
 * starts, which is what actually exhausted memory (confirmed via direct
 * measurement, not a guess) — not a leak in the batching or checkpointing
 * logic itself. Overridable via env var without a code change, since
 * density will likely keep climbing as the backfill progresses further.
 */
const BATCH_BLOCKS = process.env.MATERIALIZE_SILVER_BATCH_BLOCKS
  ? Number(process.env.MATERIALIZE_SILVER_BATCH_BLOCKS)
  : 3_000;

/**
 * Found for real (2026-09-08): the periodic full-table re-export to
 * silver/*.parquet (COPY of the *entire* accumulated table, not just new
 * rows) gets more expensive every time it runs, since the tables it's
 * copying only ever grow — 327s -> 817s and climbing over one run. Nothing
 * reads silver/*.parquet while this script is running, and a final flush
 * always happens unconditionally once the whole range completes (see
 * flushToParquet's call site after the batch loop), so there's no
 * correctness reason to flush this often mid-run. Raised well above the
 * default so it effectively only flushes at the end for a normal run;
 * still overridable if a very long run needs an intermediate flush for
 * some other consumer.
 */
const PARQUET_FLUSH_INTERVAL_BATCHES = process.env.MATERIALIZE_SILVER_FLUSH_INTERVAL_BATCHES
  ? Number(process.env.MATERIALIZE_SILVER_FLUSH_INTERVAL_BATCHES)
  : 500;

/**
 * Found for real (2026-08-30): an ~8.9M-block run against R2 over many
 * hours hit a transient DNS resolution failure reaching Cloudflare
 * ("Could not resolve hostname") — nothing wrong with the run itself, just
 * a momentary network hiccup, but it still killed the whole process and
 * needed a manual restart. Since `resumable: true` already makes every
 * restart cheap and safe (picks up from the checkpoint), retrying
 * *specifically* transient-looking network errors here removes the need
 * for a human to notice and restart every time one occurs during a run
 * long enough that they're likely to happen more than once.
 */
function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Could not resolve hostname|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|socket hang up|Connection (reset|refused|timed out)|Empty reply from server|Curl error/i.test(
    message,
  );
}

const MAX_NETWORK_RETRIES = 20;
const RETRY_DELAY_MS = 30_000;

async function main(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Materializing chain silver from bronze (resumable — safe to stop and rerun), batchBlocks=${BATCH_BLOCKS}...`);
      const result = await materializeChainSilver({
        resumable: true,
        batchBlocks: BATCH_BLOCKS,
        parquetFlushIntervalBatches: PARQUET_FLUSH_INTERVAL_BATCHES,
        onProgress: ({ batchStart, batchEnd, minBlock, maxBlock, elapsedMs }) => {
          const doneBlocks = batchEnd - minBlock + 1;
          const totalBlocks = maxBlock - minBlock + 1;
          const pct = ((doneBlocks / totalBlocks) * 100).toFixed(1);
          console.log(
            `  batch ${batchStart}-${batchEnd}: ${doneBlocks}/${totalBlocks} blocks (${pct}%), ${(elapsedMs / 1000).toFixed(0)}s elapsed`,
          );
        },
      });
      console.log(`Transfers: ${result.transfersRowCount} rows -> ${result.transfersDestination}`);
      console.log(`Balance events: ${result.balanceEventsRowCount} rows -> ${result.balanceEventsDestination}`);
      console.log(`Stake events: ${result.stakeEventsRowCount} rows -> ${result.stakeEventsDestination}`);
      if (result.skippedBlocks.length > 0) {
        console.log(
          `WARNING: ${result.skippedBlocks.length} block(s) failed to decode and were skipped: ${result.skippedBlocks.join(", ")}. ` +
            "See data/meta/materialize_silver_skipped_blocks.jsonl for details.",
        );
      }
      return;
    } catch (err) {
      if (!isTransientNetworkError(err) || attempt >= MAX_NETWORK_RETRIES) {
        throw err;
      }
      console.error(
        `materializeChainSilver: transient network error (attempt ${attempt}/${MAX_NETWORK_RETRIES}), ` +
          `retrying from checkpoint in ${RETRY_DELAY_MS / 1000}s: ${err instanceof Error ? err.message : String(err)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

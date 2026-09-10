import { loadEnvFile } from "../env.js";
import { createBlockmachineClient } from "../chain/rpcClient.js";
import { fetchBlockRange } from "../chain/fetchBlockRange.js";
import { fetchRuntimeMetadata } from "../chain/fetchMetadata.js";
import { fetchChainHead } from "../chain/fetchChainHead.js";
import { detectRuntimeSegments, type RuntimeSegment } from "../chain/detectRuntimeUpgrades.js";
import { appendRuntimeVersions } from "../chain/runtimeVersionsLog.js";
import { readCheckpoint, readCheckpointToBlock, writeCheckpoint } from "../chain/backfillCheckpoint.js";
import { writeChainEventsBronze, writeChainMetadataBronze } from "../chain/bronzeWriter.js";

/**
 * Phase 2.3 (tao-analytics-plan.md §6): the full genesis-to-head event index
 * backfill. Unlike `ingestChainRange.ts` (the Phase 2.1/2.2 tracer bullet,
 * which assumes one spec_version for its whole 1,000-block window and holds
 * everything in memory), this script:
 *
 *  - **Detects runtime upgrades per chunk** via `detectRuntimeSegments`
 *    instead of trusting one spec_version for the whole 8.9M-block pull —
 *    the gap §6 calls out as "worse than crashing, because a stale-but-
 *    structurally-valid metadata can decode new bytes into plausible-looking
 *    wrong values instead of failing loudly." Each distinct spec_version's
 *    metadata is cached to bronze the first time it's seen.
 *  - **Chunks and checkpoints.** Blocks are processed `CHAIN_CHUNK_BLOCKS`
 *    at a time; the checkpoint is written only after a chunk's bronze files
 *    are durably on disk/R2, so a crash mid-run resumes at the next chunk
 *    rather than redoing the whole backfill or silently skipping blocks.
 *    Bronze file names are deterministic (block-range keyed), so redoing a
 *    chunk after a crash before its checkpoint was written just overwrites
 *    the same file with the same bytes.
 *
 * Not run as part of `pnpm test` — this is the one expensive, hours-long
 * step that needs the Pro plan (§4.2), and its RU sizing needs re-measuring
 * against the real 3-calls/block cost before committing to a full run (see
 * §4.2's note under "Plans" and §6's "two things... need addressing").
 *
 * `CHAIN_CONCURRENCY` matters a lot here: a real 2,001-block sample against
 * Pro at concurrency 1 measured ~3.7 RPC calls/s (network round-trip latency
 * bound, not the rate limit) — projected over the full ~8.9M-block backfill
 * that's ~84 days, not the plan's ~25-37h estimate, which assumed throughput
 * near the per-minute cap. Reaching that requires multiple blocks in flight
 * at once (see `fetchBlockRange.ts`'s doc comment).
 */
async function main(): Promise<void> {
  loadEnvFile();
  const apiKey = process.env.BLOCKMACHINE_API_KEY;
  if (!apiKey) {
    console.error("BLOCKMACHINE_API_KEY is not set. See .env.example.");
    process.exitCode = 1;
    return;
  }

  const fromBlock = Number(process.env.FROM_BLOCK ?? 1);
  const chunkBlocks = Number(process.env.CHAIN_CHUNK_BLOCKS ?? 100_000);
  const maxRequestsPerMinute = Number(process.env.CHAIN_MAX_RPM ?? 40);
  const concurrency = Number(process.env.CHAIN_CONCURRENCY ?? 1);

  const client = createBlockmachineClient({
    apiKey,
    maxRequestsPerMinute,
    onProgress: ({ requestCount }) => {
      if (requestCount % 5000 === 0) console.log(`  ...${requestCount} RPC calls so far`);
    },
  });

  // Resolve TO_BLOCK once and stick with it across restarts: if left unset,
  // re-resolving "current chain head" on every run would produce a
  // different value each time (the head moves every ~12s), which would
  // never match the checkpoint's pinned toBlock and would silently restart
  // the whole range instead of resuming (see backfillCheckpoint.ts's doc
  // comment on readCheckpointToBlock).
  const toBlock = process.env.TO_BLOCK
    ? Number(process.env.TO_BLOCK)
    : (readCheckpointToBlock(fromBlock) ?? (await fetchChainHead(client)));

  console.log(
    `Chain backfill: blocks ${fromBlock}-${toBlock} (${toBlock - fromBlock + 1} blocks), ` +
      `chunked at ${chunkBlocks}, paced to ${maxRequestsPerMinute} req/min, concurrency ${concurrency}.`,
  );

  const existingCheckpoint = readCheckpoint(fromBlock, toBlock);
  let resumeFrom = fromBlock;
  if (existingCheckpoint && existingCheckpoint.lastCompletedBlock >= fromBlock) {
    resumeFrom = existingCheckpoint.lastCompletedBlock + 1;
    console.log(`Resuming from checkpoint: last completed block ${existingCheckpoint.lastCompletedBlock}.`);
  }

  if (resumeFrom > toBlock) {
    console.log("Nothing to do — checkpoint already covers the full requested range.");
    return;
  }

  const knownSpecVersions = new Set<number>();
  const startedAt = Date.now();

  for (let chunkStart = resumeFrom; chunkStart <= toBlock; chunkStart += chunkBlocks) {
    const chunkEnd = Math.min(chunkStart + chunkBlocks - 1, toBlock);
    const elapsedS = (Date.now() - startedAt) / 1000;
    console.log(`\nChunk ${chunkStart}-${chunkEnd} (${elapsedS.toFixed(0)}s elapsed, ${client.requestCount} calls so far)`);

    const segments = await detectRuntimeSegments(client, chunkStart, chunkEnd);
    if (segments.length > 1) {
      console.log(`  runtime upgrade(s) found — ${segments.length} segments: ${segments.map((s) => `${s.fromBlock}-${s.toBlock}@v${s.specVersion}`).join(", ")}`);
    }

    for (const segment of segments) {
      await ensureMetadataCached(client, segment, knownSpecVersions);

      const records = await fetchBlockRange({
        client,
        fromBlock: segment.fromBlock,
        toBlock: segment.toBlock,
        concurrency,
        onProgress: (done, total) => {
          if (done % 10_000 === 0 || done === total) {
            console.log(`    segment ${segment.fromBlock}-${segment.toBlock}: ${done}/${total} blocks`);
          }
        },
      });

      const result = await writeChainEventsBronze({
        records,
        fromBlock: segment.fromBlock,
        toBlock: segment.toBlock,
        specVersion: segment.specVersion,
      });
      console.log(`  bronze -> ${result.destination} (${result.rowCount} rows)`);
    }

    await appendRuntimeVersions(segments);
    writeCheckpoint({ fromBlock, toBlock, lastCompletedBlock: chunkEnd, updatedAtMs: Date.now() });
  }

  const totalElapsedS = (Date.now() - startedAt) / 1000;
  console.log(
    `\nBackfill complete: blocks ${fromBlock}-${toBlock}. ${client.requestCount} RPC calls, ${totalElapsedS.toFixed(0)}s.`,
  );
}

async function ensureMetadataCached(
  client: ReturnType<typeof createBlockmachineClient>,
  segment: RuntimeSegment,
  knownSpecVersions: Set<number>,
): Promise<void> {
  if (knownSpecVersions.has(segment.specVersion)) return;

  const blockHash = await client.call<string>("chain_getBlockHash", [segment.fromBlock]);
  const { specVersion, metadataHex } = await fetchRuntimeMetadata(client, blockHash);
  await writeChainMetadataBronze({ specVersion, metadataHex, capturedAtBlock: segment.fromBlock });
  knownSpecVersions.add(specVersion);
  console.log(`  cached metadata for spec_version ${specVersion} (captured at block ${segment.fromBlock})`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

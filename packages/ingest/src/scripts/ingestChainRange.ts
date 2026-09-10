import { loadEnvFile } from "../env.js";
import { createBlockmachineClient } from "../chain/rpcClient.js";
import { fetchBlockRange } from "../chain/fetchBlockRange.js";
import { fetchRuntimeMetadata } from "../chain/fetchMetadata.js";
import { writeChainEventsBronze, writeChainMetadataBronze } from "../chain/bronzeWriter.js";

/**
 * Phase 2.1 tracer bullet (tao-analytics-plan.md §6): "1,000 blocks, end to
 * end. Fetch raw events -> bronze." Defaults to blocks 1-1000 — the exact
 * range Spike G (§4.2) already probed on the free tier, so this run's RU
 * cost is known in advance rather than a fresh guess.
 *
 * At the free tier's observed 50 RU/min (measured 2026-08-26; this client
 * paces itself to 40/min, see rpcClient.ts) and 3 RPC calls per block
 * (chain_getBlockHash, two state_getStorage reads), 1,000 blocks is
 * ~3,000 RU: roughly 75 minutes wall-clock. This is meant to run as a
 * long-lived background process, not interactively.
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
  const toBlock = Number(process.env.TO_BLOCK ?? 1000);
  const maxRequestsPerMinute = Number(process.env.CHAIN_MAX_RPM ?? 40);
  const concurrency = Number(process.env.CHAIN_CONCURRENCY ?? 1);

  console.log(`Chain ingest: blocks ${fromBlock}-${toBlock} (${toBlock - fromBlock + 1} blocks), ` +
    `paced to ${maxRequestsPerMinute} req/min, concurrency ${concurrency}.`);

  const client = createBlockmachineClient({
    apiKey,
    maxRequestsPerMinute,
    onProgress: ({ requestCount }) => {
      if (requestCount % 100 === 0) console.log(`  ...${requestCount} RPC calls so far`);
    },
  });

  const startedAt = Date.now();

  const fromBlockHash = await client.call<string>("chain_getBlockHash", [fromBlock]);
  console.log(`Fetching runtime metadata at block ${fromBlock} (${fromBlockHash})...`);
  const { specVersion, metadataHex } = await fetchRuntimeMetadata(client, fromBlockHash);
  console.log(`Runtime spec_version=${specVersion}, metadata ${(metadataHex.length / 2 / 1024).toFixed(1)} KB.`);

  const metadataResult = await writeChainMetadataBronze({
    specVersion,
    metadataHex,
    capturedAtBlock: fromBlock,
  });
  console.log(`Metadata bronze -> ${metadataResult.destination}`);

  console.log(`Fetching events + timestamps for ${toBlock - fromBlock + 1} blocks...`);
  const records = await fetchBlockRange({
    client,
    fromBlock,
    toBlock,
    concurrency,
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) {
        const elapsedS = (Date.now() - startedAt) / 1000;
        console.log(`  block ${fromBlock + done - 1}: ${done}/${total} (${elapsedS.toFixed(0)}s elapsed)`);
      }
    },
  });

  const eventsResult = await writeChainEventsBronze({ records, fromBlock, toBlock, specVersion });
  console.log(`Events bronze -> ${eventsResult.destination} (${eventsResult.rowCount} rows)`);

  const elapsedS = (Date.now() - startedAt) / 1000;
  console.log(
    `Done in ${elapsedS.toFixed(0)}s, ${client.requestCount} RPC calls total. ` +
      `${records.filter((r) => r.eventsHex !== "0x00").length} of ${records.length} blocks had non-empty events.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

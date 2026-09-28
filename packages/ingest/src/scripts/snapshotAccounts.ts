import { loadEnvFile } from "../env.js";
import { createBlockmachineClient } from "../chain/rpcClient.js";
import { fetchAccountSnapshot, writeAccountSnapshotBronze } from "../chain/accountSnapshot.js";

/** Every System.Account entry at SNAPSHOT_BLOCK (default 0, genesis) -> bronze. */
async function main(): Promise<void> {
  loadEnvFile();
  const apiKey = process.env.BLOCKMACHINE_API_KEY;
  if (!apiKey) {
    console.error("BLOCKMACHINE_API_KEY is not set. See .env.example.");
    process.exitCode = 1;
    return;
  }
  const blockNumber = Number(process.env.SNAPSHOT_BLOCK ?? 0);
  const client = createBlockmachineClient({ apiKey, maxRequestsPerMinute: Number(process.env.CHAIN_MAX_RPM ?? 600) });

  const snapshot = await fetchAccountSnapshot(client, blockNumber);
  const result = await writeAccountSnapshotBronze(snapshot);
  console.log(
    `Snapshot of block ${blockNumber} (spec_version ${snapshot.specVersion}): ${snapshot.rows.length} accounts, ` +
      `${client.requestCount} RPC calls -> ${result.destination}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { loadEnvFile } from "@tao-tools/ingest";
import { repairUpgradeBlocks } from "../chain/materializeChainSilver.js";

async function main(): Promise<void> {
  loadEnvFile();
  console.log("Re-decoding runtime-upgrade and conflicting-stamp blocks in the silver staging DB...");
  const { repairedBlocks, changedBlocks } = await repairUpgradeBlocks();
  console.log(`Re-decoded ${repairedBlocks.length} block(s); ${changedBlocks.length} changed:`);
  for (const { blockNumber, rowsBefore, rowsAfter } of changedBlocks) {
    console.log(`  block ${blockNumber}: ${rowsBefore} -> ${rowsAfter} silver rows`);
  }
  console.log("silver/*.parquet re-exported from the staging DB.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

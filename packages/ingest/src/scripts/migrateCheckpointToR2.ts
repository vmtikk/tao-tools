import { loadEnvFile } from "../env.js";
import { readRawCheckpoint } from "../chain/backfillCheckpoint.js";
import { isRemoteBronze, readCheckpointFromR2, writeCheckpointToR2 } from "../chain/r2Checkpoint.js";

/**
 * One-time migration for repos that ran `chain:backfill` before the
 * checkpoint moved to R2 (see chain/r2Checkpoint.ts): copies the existing
 * local `data/meta/chain_backfill_checkpoint.json` up to
 * `chain/meta/backfill_checkpoint.json` in the same R2 bucket bronze already
 * lives in. Run this once, from whichever machine holds the real local
 * checkpoint, before pointing `sync-bronze.sh` at a fresh machine — without
 * it, the first R2-backed run finds nothing there and restarts from block 1
 * instead of resuming.
 */
async function main(): Promise<void> {
  loadEnvFile();
  if (!isRemoteBronze()) {
    console.error("BRONZE_URI is not s3:// — nothing to migrate, checkpoint stays local as-is.");
    process.exitCode = 1;
    return;
  }

  const local = readRawCheckpoint();
  if (!local) {
    console.error("No local checkpoint at data/meta/chain_backfill_checkpoint.json to migrate.");
    process.exitCode = 1;
    return;
  }

  const existingRemote = await readCheckpointFromR2();
  if (existingRemote) {
    console.error(
      `R2 already has a checkpoint (lastCompletedBlock ${existingRemote.lastCompletedBlock}) — ` +
        "refusing to overwrite it. Delete chain/meta/backfill_checkpoint.json in R2 first if you " +
        "really mean to replace it with the local one.",
    );
    process.exitCode = 1;
    return;
  }

  await writeCheckpointToR2(local);
  console.log(
    `Migrated checkpoint to R2: lastCompletedBlock ${local.lastCompletedBlock} (range ${local.fromBlock}-${local.toBlock}).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

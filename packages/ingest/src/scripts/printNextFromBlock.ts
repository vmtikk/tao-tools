import { loadEnvFile } from "../env.js";
import { readEffectiveCheckpoint } from "../chain/r2Checkpoint.js";

/**
 * Prints `lastCompletedBlock + 1` from whichever checkpoint backend is
 * active (R2 if `BRONZE_URI` is `s3://`, local disk otherwise) — or `1` if
 * there's no checkpoint anywhere yet. `sync-bronze.sh` shells out to this to
 * compute `FROM_BLOCK` for its next incremental `chain:backfill` run, so it
 * doesn't need its own copy of the local-vs-R2 branching logic.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const checkpoint = await readEffectiveCheckpoint();
  console.log(checkpoint ? checkpoint.lastCompletedBlock + 1 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

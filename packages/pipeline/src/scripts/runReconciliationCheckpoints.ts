import { createBlockmachineClient, loadEnvFile } from "@tao-tools/ingest";
import { runReconciliationCheckpoints } from "../chain/runReconciliationCheckpoints.js";
import {
  decodeKnownGoodBalances,
  encodeKnownGoodBalances,
  readReconciliationCheckpoint,
  writeReconciliationCheckpoint,
} from "../chain/reconciliationCheckpoint.js";

/**
 * Phase 2.3 (tao-analytics-plan.md §6): "reconciles against monthly
 * checkpoints" — runs `reconcileBalances` incrementally over consecutive
 * windows from genesis (or `FROM_BLOCK`) up to `UP_TO_BLOCK`, which should
 * be whatever block `chain:materialize-silver` has actually decoded up to,
 * not the eventual chain head. Run this again with a larger `UP_TO_BLOCK`
 * as the backfill (and re-materialization) progresses — only the newly-
 * reachable windows get processed, both because each window's fold work is
 * O(window) and because (since 2026-09-11) windows already completed in an
 * earlier invocation are skipped entirely via `reconciliationCheckpoint.ts`,
 * not re-verified from scratch — a real run spends real RU on every
 * `state_getStorage` call, so repeating already-validated windows after a
 * restart would waste both RU and the hours already spent.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const apiKey = process.env.BLOCKMACHINE_API_KEY;
  if (!apiKey) {
    console.error("BLOCKMACHINE_API_KEY is not set. See .env.example.");
    process.exitCode = 1;
    return;
  }

  const upToBlockEnv = process.env.UP_TO_BLOCK;
  if (!upToBlockEnv) {
    console.error(
      "UP_TO_BLOCK is not set. Pass the block number chain:materialize-silver has actually decoded up to " +
        "(check data/meta/chain_backfill_checkpoint.json's lastCompletedBlock, then confirm silver was " +
        "re-materialized against that bronze) — not the live chain head.",
    );
    process.exitCode = 1;
    return;
  }

  const fromBlock = Number(process.env.FROM_BLOCK ?? 1);
  const upToBlock = Number(upToBlockEnv);
  const intervalBlocks = Number(process.env.CHECKPOINT_INTERVAL_BLOCKS ?? 216_000); // ~30 days at 12s/block
  const concurrency = Number(process.env.CHAIN_CONCURRENCY ?? 1);

  const client = createBlockmachineClient({
    apiKey,
    maxRequestsPerMinute: Number(process.env.CHAIN_MAX_RPM ?? 40),
  });

  const checkpoint = readReconciliationCheckpoint(fromBlock, intervalBlocks);
  const resumeFrom = checkpoint
    ? { windowStart: checkpoint.lastCompletedWindowEnd + 1, knownGoodBalances: decodeKnownGoodBalances(checkpoint.knownGoodBalances) }
    : undefined;
  let priorMismatches = checkpoint?.totalMismatches ?? 0;

  if (checkpoint) {
    console.log(
      `Resuming from checkpoint: windows up to block ${checkpoint.lastCompletedWindowEnd} already reconciled ` +
        `(${priorMismatches} mismatch(es) so far).`,
    );
  }

  console.log(
    `Running reconciliation checkpoints: blocks ${fromBlock}-${upToBlock}, ${intervalBlocks} blocks/checkpoint, concurrency ${concurrency}.`,
  );

  const checkpoints = await runReconciliationCheckpoints({
    client,
    intervalBlocks,
    upToBlock,
    fromBlock,
    concurrency,
    resumeFrom,
    onWindowComplete: (result, knownGoodBalances) => {
      priorMismatches += result.mismatches.length;
      writeReconciliationCheckpoint({
        fromBlock,
        intervalBlocks,
        lastCompletedWindowEnd: result.toBlock,
        knownGoodBalances: encodeKnownGoodBalances(knownGoodBalances),
        totalMismatches: priorMismatches,
        updatedAtMs: Date.now(),
      });
    },
  });

  if (checkpoints.length === 0) {
    console.log(
      checkpoint
        ? `No new ${intervalBlocks}-block window fits in [${resumeFrom!.windowStart}, ${upToBlock}] yet.`
        : `No complete ${intervalBlocks}-block window fits in [${fromBlock}, ${upToBlock}] yet.`,
    );
    return;
  }

  let newMismatches = 0;
  for (const cp of checkpoints) {
    const status = cp.mismatches.length === 0 ? "OK" : "MISMATCH";
    console.log(`  [${status}] blocks ${cp.fromBlock}-${cp.toBlock}: ${cp.touchedAccounts} touched, ${cp.mismatches.length} mismatched`);
    for (const row of cp.mismatches) {
      console.log(`      ${row.coldkey}: reconstructed=${row.reconstructedRao} actual=${row.actualRao}`);
    }
    newMismatches += cp.mismatches.length;
  }

  if (priorMismatches === 0) {
    console.log(`All checkpoints reconciled exactly (${checkpoints.length} new this run).`);
  } else {
    console.error(`${priorMismatches} mismatch(es) total (${newMismatches} new this run). Fold has a gap.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

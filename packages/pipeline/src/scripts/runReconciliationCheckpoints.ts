import { createBlockmachineClient } from "@tao-tools/ingest";
import { runReconciliationCheckpoints } from "../chain/runReconciliationCheckpoints.js";

/**
 * Phase 2.3 (tao-analytics-plan.md §6): "reconciles against monthly
 * checkpoints" — runs `reconcileBalances` incrementally over consecutive
 * windows from genesis (or `FROM_BLOCK`) up to `UP_TO_BLOCK`, which should
 * be whatever block `chain:materialize-silver` has actually decoded up to,
 * not the eventual chain head. Run this again with a larger `UP_TO_BLOCK`
 * as the backfill (and re-materialization) progresses — it only recomputes
 * the newly-reachable windows in the sense that each window's own fold work
 * is O(window), but note it does still re-verify every earlier window from
 * scratch on each invocation (no cross-run checkpoint persistence yet); what
 * it avoids is the *double-counting* and *redundant on-chain reads* a naive
 * "just call reconcileBalances(1, UP_TO_BLOCK)" would hit.
 */
async function main(): Promise<void> {
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

  const client = createBlockmachineClient({
    apiKey,
    maxRequestsPerMinute: Number(process.env.CHAIN_MAX_RPM ?? 40),
  });

  console.log(
    `Running reconciliation checkpoints: blocks ${fromBlock}-${upToBlock}, ${intervalBlocks} blocks/checkpoint.`,
  );

  const checkpoints = await runReconciliationCheckpoints({ client, intervalBlocks, upToBlock, fromBlock });

  if (checkpoints.length === 0) {
    console.log(`No complete ${intervalBlocks}-block window fits in [${fromBlock}, ${upToBlock}] yet.`);
    return;
  }

  let totalMismatches = 0;
  for (const checkpoint of checkpoints) {
    const status = checkpoint.mismatches.length === 0 ? "OK" : "MISMATCH";
    console.log(
      `  [${status}] blocks ${checkpoint.fromBlock}-${checkpoint.toBlock}: ` +
        `${checkpoint.touchedAccounts} touched, ${checkpoint.mismatches.length} mismatched`,
    );
    for (const row of checkpoint.mismatches) {
      console.log(`      ${row.coldkey}: reconstructed=${row.reconstructedRao} actual=${row.actualRao}`);
    }
    totalMismatches += checkpoint.mismatches.length;
  }

  if (totalMismatches === 0) {
    console.log(`All ${checkpoints.length} checkpoints reconciled exactly.`);
  } else {
    console.error(`${totalMismatches} mismatch(es) across ${checkpoints.length} checkpoints. Fold has a gap.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

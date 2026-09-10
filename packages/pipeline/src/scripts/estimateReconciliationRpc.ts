import { withDuckDb } from "../duckdb/session.js";
import { silverDir } from "../paths.js";
import { estimateReconciliationRpc } from "../chain/estimateReconciliationRpc.js";

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Sizes `chain:reconcile-checkpoints` before spending any RU budget on it
 * (tao-analytics-plan.md §6, closeout item 3) — pure local DuckDB over
 * already-decoded silver, no RPC calls, no `BLOCKMACHINE_API_KEY` needed.
 */
async function main(): Promise<void> {
  const upToBlockEnv = process.env.UP_TO_BLOCK;
  if (!upToBlockEnv) {
    console.error(
      "UP_TO_BLOCK is not set. Pass the same value you'd give chain:reconcile-checkpoints " +
        "(check data/meta/chain_backfill_checkpoint.json's lastCompletedBlock).",
    );
    process.exitCode = 1;
    return;
  }

  const fromBlock = Number(process.env.FROM_BLOCK ?? 1);
  const upToBlock = Number(upToBlockEnv);
  const intervalBlocks = Number(process.env.CHECKPOINT_INTERVAL_BLOCKS ?? 216_000);
  const ruPerCall = Number(process.env.RU_PER_CALL ?? 1);

  const transfersPath = `${silverDir()}/transfers.parquet`;
  const balanceEventsPath = `${silverDir()}/balance_events.parquet`;

  const estimate = await withDuckDb(
    async (connection) => {
      await connection.run(
        `CREATE VIEW silver_transfers AS SELECT * FROM read_parquet('${escapeSqlLiteral(transfersPath)}');`,
      );
      await connection.run(
        `CREATE VIEW silver_balance_events AS SELECT * FROM read_parquet('${escapeSqlLiteral(balanceEventsPath)}');`,
      );
      return estimateReconciliationRpc(connection, { fromBlock, upToBlock, intervalBlocks });
    },
    { memoryLimit: "3GB" },
  );

  if (estimate.windows.length === 0) {
    console.log(`No complete ${intervalBlocks}-block window fits in [${fromBlock}, ${upToBlock}].`);
    return;
  }

  console.log(
    `Estimating chain:reconcile-checkpoints over blocks ${fromBlock}-${upToBlock}, ` +
      `${intervalBlocks} blocks/window (${estimate.windows.length} complete windows):\n`,
  );
  for (const w of estimate.windows) {
    console.log(
      `  window ${w.windowIndex}: blocks ${w.fromBlock}-${w.toBlock} | ` +
        `touched=${w.touchedAccounts} newly_touched=${w.newlyTouchedAccounts}`,
    );
  }

  console.log(
    `\nTotal actual-balance reads (touched, per window): ${estimate.totalActualReads}\n` +
      `Total baseline reads (newly touched, one-time):    ${estimate.totalBaselineReads}\n` +
      `Total window overhead (hash + runtime version):     ${estimate.totalWindowOverheadCalls}\n` +
      `Estimated total RPC calls:                          ${estimate.totalCalls}\n` +
      `Estimated RU at ${ruPerCall} RU/call:                          ${Math.round(estimate.totalCalls * ruPerCall)}`,
  );
  console.log(
    "\nDoes not count the state_getMetadata fallback (only fires on a spec_version cache miss; " +
      "the backfill already cached every spec_version into bronze) — treat this as a lower bound. " +
      "Confirm the ~1 RU/call conversion against the Blockmachine dashboard before spending it (plan §4.2).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

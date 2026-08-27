import { createBlockmachineClient } from "@tao-tools/ingest";
import { reconcileBalances } from "../chain/reconcileBalances.js";

async function main(): Promise<void> {
  const apiKey = process.env.BLOCKMACHINE_API_KEY;
  if (!apiKey) {
    console.error("BLOCKMACHINE_API_KEY is not set. See .env.example.");
    process.exitCode = 1;
    return;
  }

  const fromBlock = Number(process.env.FROM_BLOCK ?? 1);
  const toBlock = Number(process.env.TO_BLOCK ?? 1000);
  const client = createBlockmachineClient({
    apiKey,
    maxRequestsPerMinute: Number(process.env.CHAIN_MAX_RPM ?? 40),
  });

  console.log(`Reconciling balances for blocks ${fromBlock}-${toBlock}...`);
  const result = await reconcileBalances({ fromBlock, toBlock, client });

  console.log(`Baseline block: ${result.fromBlock - 1} (${result.startBlockHash})`);
  console.log(`End block: ${result.toBlock} (${result.endBlockHash})`);
  console.log(`Touched coldkeys: ${result.touchedAccounts}`);

  const mismatches = result.rows.filter((r) => !r.matches);
  for (const row of result.rows) {
    const status = row.matches ? "OK" : "MISMATCH";
    console.log(
      `  [${status}] ${row.coldkey}: baseline=${row.baselineRao} reconstructed=${row.reconstructedRao} actual=${row.actualRao}`,
    );
  }

  if (result.touchedAccounts === 0) {
    console.log("No balance-affecting events observed in this range — nothing to reconcile.");
  } else if (mismatches.length === 0) {
    console.log(`All ${result.touchedAccounts} touched coldkeys reconciled exactly. Fold is correct for this range.`);
  } else {
    console.error(`${mismatches.length}/${result.touchedAccounts} coldkeys did NOT reconcile. Fold has a gap.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { materializeChainSilver } from "../chain/materializeChainSilver.js";

async function main(): Promise<void> {
  const result = await materializeChainSilver();
  console.log(`Transfers: ${result.transfersRowCount} rows -> ${result.transfersDestination}`);
  console.log(`Balance events: ${result.balanceEventsRowCount} rows -> ${result.balanceEventsDestination}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

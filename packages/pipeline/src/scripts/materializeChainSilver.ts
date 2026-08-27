import { materializeChainSilver } from "../chain/materializeChainSilver.js";

async function main(): Promise<void> {
  console.log("Materializing chain silver from bronze...");
  const result = await materializeChainSilver({
    onProgress: ({ batchStart, batchEnd, minBlock, maxBlock, elapsedMs }) => {
      const doneBlocks = batchEnd - minBlock + 1;
      const totalBlocks = maxBlock - minBlock + 1;
      const pct = ((doneBlocks / totalBlocks) * 100).toFixed(1);
      console.log(
        `  batch ${batchStart}-${batchEnd}: ${doneBlocks}/${totalBlocks} blocks (${pct}%), ${(elapsedMs / 1000).toFixed(0)}s elapsed`,
      );
    },
  });
  console.log(`Transfers: ${result.transfersRowCount} rows -> ${result.transfersDestination}`);
  console.log(`Balance events: ${result.balanceEventsRowCount} rows -> ${result.balanceEventsDestination}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { writeGoldExport } from "../export/writeGoldExport.js";

async function main(): Promise<void> {
  const result = await writeGoldExport();
  console.log(`Exported ${result.seriesCount} series -> ${result.destination}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

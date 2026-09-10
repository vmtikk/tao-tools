import { loadEnvFile } from "@tao-tools/ingest";
import { materializeSilverOhlcv } from "../silver/materializeOhlcv.js";
import { materializeSilverGoogleTrends } from "../silver/materializeGoogleTrends.js";
import { materializeGold } from "../gold/materialize.js";

async function main(): Promise<void> {
  // Without this, BRONZE_URI/R2 credentials are only picked up if the shell
  // already has them exported — found for real (2026-09-10) chasing a
  // brand-new bronze source (Trends) that materialized to 0 rows: this
  // process silently fell back to the local ./data/bronze stand-in instead
  // of reading real R2, and that stand-in still has enough old cached price
  // data locally to look like it was working.
  loadEnvFile();

  const silver = await materializeSilverOhlcv();
  console.log(`Silver: ${silver.rowCount} rows -> ${silver.destination}`);

  const trendsSilver = await materializeSilverGoogleTrends();
  if (trendsSilver) {
    console.log(`Silver: ${trendsSilver.rowCount} rows -> ${trendsSilver.destination}`);
  } else {
    console.log("Silver: no Google Trends bronze found yet, skipping (run `pnpm trends:backfill` first)");
  }

  const gold = await materializeGold();
  for (const g of gold) {
    console.log(`Gold: ${g.metric} — ${g.rowCount} rows -> ${g.destination}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

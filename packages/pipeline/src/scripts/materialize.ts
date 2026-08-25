import { materializeSilverOhlcv } from "../silver/materializeOhlcv.js";
import { materializeGold } from "../gold/materialize.js";

async function main(): Promise<void> {
  const silver = await materializeSilverOhlcv();
  console.log(`Silver: ${silver.rowCount} rows -> ${silver.destination}`);

  const gold = await materializeGold();
  for (const g of gold) {
    console.log(`Gold: ${g.metric} — ${g.rowCount} rows -> ${g.destination}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

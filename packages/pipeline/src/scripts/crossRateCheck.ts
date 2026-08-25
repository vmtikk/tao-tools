import { runCrossRateCheck } from "../crossRate/runCheck.js";

/**
 * Intended to run nightly (tao-analytics-plan.md §6, Phase 1.3) once gold is
 * materialized — this only reads already-materialized gold, it doesn't
 * rebuild anything. Exits non-zero on any flagged bucket so it can gate a
 * scheduled job in Phase 5 without extra wiring.
 */
async function main(): Promise<void> {
  const { divergences } = await runCrossRateCheck();

  if (divergences.length === 0) {
    console.log("Cross-rate check: TAO/USD ÷ BTC/USD tracks TAO/BTC within threshold. PASS.");
    return;
  }

  console.error(`Cross-rate check: ${divergences.length} bucket(s) diverge beyond threshold:`);
  for (const d of divergences.slice(0, 20)) {
    console.error(
      `  t=${d.timestampMs}: implied=${d.impliedTaoBtc.toFixed(8)} observed=${d.observedTaoBtc.toFixed(8)} ` +
        `divergence=${(d.divergence * 100).toFixed(2)}%`,
    );
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

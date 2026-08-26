import { loadGoldExport } from "../lib/loadGoldExport";
import { LiveUsdPriceChart } from "../components/LiveUsdPriceChart";
import { PriceChart } from "../components/PriceChart";
import { VolumeChart } from "../components/VolumeChart";
import { TransferCountChart } from "../components/TransferCountChart";

export default function HomePage() {
  const gold = loadGoldExport();
  const usdSeries = gold.series.find((s) => s.metric === "price_composite_usd");
  const btcSeries = gold.series.find((s) => s.metric === "price_composite_btc");
  const volumeSeries = gold.series.find((s) => s.metric === "volume_usd_daily");
  const transferCountSeries = gold.series.find((s) => s.metric === "transfer_count_per_block");

  return (
    <main>
      <h1>TAO Analytics</h1>
      <p className="subtitle">Volume-weighted composite prices and trading volume, across every venue polled.</p>

      <section className="chart-section">
        <h2>TAO / USD</h2>
        <p className="section-subtitle">
          1-minute resolution.
          {usdSeries ? ` Metric v${usdSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <LiveUsdPriceChart points={usdSeries?.points ?? []} />
          <p className="caveat">
            Composite across polled venues only (Kraken, Coinbase, and USDT-quoted Binance, Bybit,
            OKX, MEXC, Gate — USDT treated as USD-equivalent) — undercounts vs. aggregators,
            especially in early history (tao-analytics-plan.md §4.1).
          </p>
        </div>
      </section>

      <section className="chart-section">
        <h2>TAO / BTC</h2>
        <p className="section-subtitle">
          1-minute resolution.
          {btcSeries ? ` Metric v${btcSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <PriceChart points={btcSeries?.points ?? []} unit="btc" ariaLabel="TAO/BTC composite price line chart" />
          <p className="caveat">Composite across Kraken and Upbit only.</p>
        </div>
      </section>

      <section className="chart-section">
        <h2>Trading volume (USD)</h2>
        <p className="section-subtitle">
          Daily, across USD/USDT venues.
          {volumeSeries ? ` Metric v${volumeSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <VolumeChart points={volumeSeries?.points ?? []} />
          <p className="caveat">
            Sums only the venues this pipeline polls — undercounts vs. aggregators that see every
            venue (tao-analytics-plan.md §4.1).
          </p>
        </div>
      </section>

      <section className="chart-section">
        <h2>Transfer count per block</h2>
        <p className="section-subtitle">
          Phase 2.1 tracer bullet: blocks 1-1000 from genesis, decoded from raw chain events.
          {transferCountSeries ? ` Metric v${transferCountSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <TransferCountChart points={transferCountSeries?.points ?? []} />
          <p className="caveat">
            Proves the chain decode path end to end (bronze -&gt; silver -&gt; gold), not a
            representative activity chart — this window is the chain&apos;s first ~3 hours.
          </p>
        </div>
      </section>
    </main>
  );
}

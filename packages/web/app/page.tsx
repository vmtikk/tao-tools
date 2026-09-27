import { loadGoldExport } from "../lib/loadGoldExport";
import { LiveUsdPriceChart } from "../components/LiveUsdPriceChart";
import { PriceChart } from "../components/PriceChart";
import { VolumeChart } from "../components/VolumeChart";
import { TransferCountChart } from "../components/TransferCountChart";

export default function HomePage() {
  const gold = loadGoldExport();
  const usdSeries = gold.series.find((s) => s.metric === "price_composite_usd_daily");
  const btcSeries = gold.series.find((s) => s.metric === "price_composite_btc_daily");
  const volumeSeries = gold.series.find((s) => s.metric === "volume_usd_daily");
  const transferCountSeries = gold.series.find((s) => s.metric === "transfer_count_daily");
  const protocolTransferCountSeries = gold.series.find((s) => s.metric === "transfer_count_protocol_daily");

  return (
    <main>
      <h1>TAO Analytics</h1>
      <p className="subtitle">Volume-weighted composite prices across every venue polled; trading volume from Binance only (see caveat below).</p>

      <section className="chart-section">
        <h2>TAO / USD</h2>
        <p className="section-subtitle">
          Daily (last 1-minute composite value each UTC day).
          {usdSeries ? ` Metric v${usdSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <LiveUsdPriceChart points={usdSeries?.points ?? []} />
          <p className="caveat">
            Composite across polled venues only (Kraken, Coinbase, and USDT-quoted Binance, OKX,
            MEXC — USDT treated as USD-equivalent) — undercounts vs. aggregators, especially in
            early history (tao-analytics-plan.md §4.1).
          </p>
        </div>
      </section>

      <section className="chart-section">
        <h2>TAO / BTC (implied)</h2>
        <p className="section-subtitle">
          Daily (last 1-minute value each UTC day).
          {btcSeries ? ` Metric v${btcSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <PriceChart points={btcSeries?.points ?? []} unit="btc" ariaLabel="TAO/BTC implied price line chart" />
          <p className="caveat">
            <strong>Implied, not an observed market price</strong> — no exchange lists a real,
            continuously-tradable TAO/BTC pair. Computed as TAO/USD ÷ BTC/USD, the same way a
            trader would price an illiquid cross by routing through a common quote currency
            (tao-analytics-plan.md §4.1).
          </p>
        </div>
      </section>

      <section className="chart-section">
        <h2>Trading volume (USD)</h2>
        <p className="section-subtitle">
          Daily, in USD. Binance only.
          {volumeSeries ? ` Metric v${volumeSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <VolumeChart points={volumeSeries?.points ?? []} />
          <p className="caveat">
            <strong>Binance only, deliberately</strong> — other polled venues (Coinbase, OKX, MEXC)
            only started trading TAO much later than Binance, so summing them in would make the
            series jump every time a new venue came online rather than reflecting real activity
            change. Undercounts vs. aggregators, but every point is comparable to every other
            (tao-analytics-plan.md §4.1).
          </p>
        </div>
      </section>

      <section className="chart-section">
        <h2>Daily user transfers</h2>
        <p className="section-subtitle">
          Daily, decoded from raw chain events, over whatever block range is currently backfilled.
          {transferCountSeries ? ` Metric v${transferCountSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <TransferCountChart points={transferCountSeries?.points ?? []} />
          <p className="caveat">
            <strong>Excludes runtime-driven transfers</strong> — any transfer with a pallet-derived
            account (e.g. subtensor&apos;s own subnet accounts) on either side is counted in the protocol
            chart below instead. Covers whatever prefix of chain history <code>chain:backfill</code> has
            reached so far (tao-analytics-plan.md §6).
          </p>
        </div>
      </section>

      <section className="chart-section">
        <h2>Daily protocol transfers</h2>
        <p className="section-subtitle">
          Transfers with a pallet-derived account on either side.
          {protocolTransferCountSeries ? ` Metric v${protocolTransferCountSeries.version}.` : ""}
        </p>
        <div className="chart-card">
          <TransferCountChart points={protocolTransferCountSeries?.points ?? []} />
          <p className="caveat">
            Internal protocol movements, not user activity. Near zero until subtensor runtime 411
            (block 8,283,784, May 2026), which began sweeping each subnet&apos;s account into the main
            subtensor account roughly 200 times a block.
          </p>
        </div>
      </section>
    </main>
  );
}

import { loadGoldExport } from "../lib/loadGoldExport";
import { PriceChart } from "../components/PriceChart";

export default function HomePage() {
  const gold = loadGoldExport();
  const series = gold.series.find((s) => s.metric === "price_composite_usd");

  return (
    <main>
      <h1>TAO / USD</h1>
      <p className="subtitle">
        Volume-weighted composite close, 1-minute resolution.
        {series ? ` Metric v${series.version}.` : ""}
      </p>
      <div className="chart-card">
        <PriceChart points={series?.points ?? []} />
        <p className="caveat">
          Composite across polled venues only — undercounts vs. aggregators, especially in early
          history (tao-analytics-plan.md §4.1).
        </p>
      </div>
    </main>
  );
}

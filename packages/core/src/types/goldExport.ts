import type { UnixMillis } from "./brands.js";

/**
 * The shape of /data/export/gold.json (tao-analytics-plan.md §9). Imported
 * by both the pipeline's export writer and the web app's chart components so
 * a metric whose shape changes breaks the web build, not the chart.
 */
export interface GoldSeriesPoint {
  timestampMs: UnixMillis;
  value: number;
}

export interface GoldSeries {
  /** Metric registry name, e.g. "price_composite_usd". */
  metric: string;
  /** Metric registry version that produced this series. */
  version: number;
  points: GoldSeriesPoint[];
}

export interface GoldExport {
  generatedAt: UnixMillis;
  series: GoldSeries[];
}

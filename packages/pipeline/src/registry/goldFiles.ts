/**
 * Physical gold Parquet filename per metric. Defaults to the metric name;
 * overridden where §2's layout names a shared table (e.g. a future
 * TAO/BTC composite would also live in `price_composite_1m`, alongside
 * `price_composite_usd`, rather than getting its own file).
 */
const GOLD_FILE_BY_METRIC: Record<string, string> = {
  price_composite_usd: "price_composite_1m",
};

export function goldFileForMetric(metricName: string): string {
  return GOLD_FILE_BY_METRIC[metricName] ?? metricName;
}

/**
 * Physical gold Parquet filename per metric. Defaults to the metric name.
 *
 * `price_composite_usd` keeps the `price_composite_1m` name from Phase 0's
 * layout sketch (§2) — but that name is not shared with `price_composite_btc`
 * or any other metric: each metric always gets its own file, one COPY per
 * registry entry (see materializeGold). Two metrics writing to the same file
 * would have the second overwrite the first, since COPY replaces rather than
 * appends a column.
 */
const GOLD_FILE_BY_METRIC: Record<string, string> = {
  price_composite_usd: "price_composite_1m",
};

export function goldFileForMetric(metricName: string): string {
  return GOLD_FILE_BY_METRIC[metricName] ?? metricName;
}

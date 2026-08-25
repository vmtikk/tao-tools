export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

/**
 * Deliberately not `Intl`'s `notation: "compact"` — it renders round values
 * differently between Node's server-render ICU build and the browser's
 * ("$0" vs "$0.0", "$2M" vs "$2.0M"), which trips a hydration mismatch on
 * every page load. Plain arithmetic can't diverge between environments.
 */
export function formatUsdCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  const [divisor, suffix] =
    abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];

  if (divisor === 1) return `${sign}$${abs.toFixed(0)}`;

  const scaled = (abs / divisor).toFixed(1);
  const trimmed = scaled.endsWith(".0") ? scaled.slice(0, -2) : scaled;
  return `${sign}$${trimmed}${suffix}`;
}

export function formatBtc(value: number): string {
  return `${value.toFixed(6)} BTC`;
}

export function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDay(timestampMs: number): string {
  return new Date(timestampMs).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

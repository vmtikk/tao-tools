/**
 * `Math.min(...arr)` / `Math.max(...arr)` spread every element as a call
 * argument, which blows the call stack well before a real chain-scale series
 * does — found for real (2026-09-05) once transfer_count_per_block hit 1.3M
 * points. A plain loop has no such limit.
 */
export function arrayMin(values: readonly number[]): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

export function arrayMax(values: readonly number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return max;
}

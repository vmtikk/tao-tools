import { z } from "zod";

/**
 * Schema for one entry in /meta/metrics_registry.yaml (tao-analytics-plan.md
 * §8). Loaded through Zod so a malformed entry fails at startup with a line
 * number instead of mid-materialization.
 */
export const MetricEntrySchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive(),
  definition: z.string().min(1),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  sql: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  changelog: z.array(z.record(z.string())).default([]),
  /** False for internal reference series (e.g. a cross-rate check input) that
   * materialize to gold like any other metric but never ship in gold.json —
   * they aren't one of the charts, just plumbing another metric depends on. */
  export: z.boolean().default(true),
});

export type MetricEntry = z.infer<typeof MetricEntrySchema>;

export const MetricsRegistrySchema = z.array(MetricEntrySchema);

export type MetricsRegistry = z.infer<typeof MetricsRegistrySchema>;

/**
 * Topologically sorts registry entries by `depends_on` so gold
 * materialization runs producers before consumers. Throws on an unknown
 * dependency or a cycle — both are registry authoring bugs, not runtime
 * conditions to recover from.
 */
export function orderByDependency(entries: readonly MetricEntry[]): MetricEntry[] {
  const byName = new Map(entries.map((e) => [e.name, e]));
  for (const entry of entries) {
    for (const dep of entry.depends_on) {
      if (!byName.has(dep)) {
        throw new Error(`Metric "${entry.name}" depends on unknown metric "${dep}"`);
      }
    }
  }

  const ordered: MetricEntry[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Cycle detected in metric registry involving "${name}"`);
    }
    visiting.add(name);
    const entry = byName.get(name);
    if (!entry) throw new Error(`Unknown metric "${name}"`);
    for (const dep of entry.depends_on) visit(dep);
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  }

  for (const entry of entries) visit(entry.name);
  return ordered;
}

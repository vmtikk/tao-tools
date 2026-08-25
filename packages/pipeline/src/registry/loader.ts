import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { MetricsRegistrySchema, orderByDependency, type MetricEntry } from "@tao-tools/core";
import { metaDir } from "../paths.js";

export function defaultRegistryPath(): string {
  return `${metaDir()}/metrics_registry.yaml`;
}

/** Loads, validates (§8), and dependency-orders the metric registry. */
export function loadRegistry(path: string = defaultRegistryPath()): MetricEntry[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = parse(raw);
  const validated = MetricsRegistrySchema.parse(parsed);
  return orderByDependency(validated);
}

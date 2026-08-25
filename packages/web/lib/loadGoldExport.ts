import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoldExport } from "@tao-tools/core";

/**
 * The site never queries anything at runtime (tao-analytics-plan.md §9) — it
 * reads the static file the nightly pipeline job produced. No RPC calls, no
 * R2 access, no API keys in the frontend.
 */
export function loadGoldExport(): GoldExport {
  const path = process.env.GOLD_EXPORT_PATH ?? join(process.cwd(), "..", "..", "data", "export", "gold.json");
  // The env override makes this path dynamic to static analysis, which would
  // otherwise make Turbopack trace (and bundle) the whole repo as output. It's
  // one small committed JSON file read once at build time, not worth tracing for.
  const raw = readFileSync(/* turbopackIgnore: true */ path, "utf-8");
  return JSON.parse(raw) as GoldExport;
}

import { join } from "node:path";

// packages/pipeline/src/paths.ts -> repo root, regardless of whether this
// runs from src (tsx) or dist (tsc) — both sit one level under the package
// dir — and regardless of the invoking process's cwd (pnpm --filter sets
// cwd to the package directory, not the repo root).
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Layout from tao-analytics-plan.md §2. Silver and gold are hot and always
 * live on local disk; only bronze's location varies (local stand-in vs R2),
 * controlled by BRONZE_URI.
 */
export function resolveDataRoot(): string {
  return (process.env.DATA_ROOT ?? join(REPO_ROOT, "data")).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function resolveBronzeUri(): string {
  return (process.env.BRONZE_URI ?? `${resolveDataRoot()}/bronze`).replace(/\/+$/, "");
}

export function silverDir(): string {
  return `${resolveDataRoot()}/silver`;
}

export function goldDir(): string {
  return `${resolveDataRoot()}/gold`;
}

export function metaDir(): string {
  return `${resolveDataRoot()}/meta`;
}

export function exportDir(): string {
  return `${resolveDataRoot()}/export`;
}

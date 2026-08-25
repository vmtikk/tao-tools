import { join } from "node:path";

// packages/ingest/src/paths.ts -> repo root, regardless of whether this runs
// from src (tsx) or dist (tsc) and regardless of the invoking process's cwd
// (pnpm --filter sets cwd to the package directory, not the repo root).
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/** Mirrors packages/pipeline/src/paths.ts's resolveDataRoot — both packages
 * compute this independently (ingest never imports pipeline, per §3's
 * dependency rule) but must agree on where local data lives. */
export function resolveDataRoot(): string {
  return (process.env.DATA_ROOT ?? join(REPO_ROOT, "data")).replace(/\\/g, "/").replace(/\/+$/, "");
}

export function resolveBronzeUri(): string {
  return (process.env.BRONZE_URI ?? `${resolveDataRoot()}/bronze`).replace(/\/+$/, "");
}

export function metaDir(): string {
  return `${resolveDataRoot()}/meta`;
}

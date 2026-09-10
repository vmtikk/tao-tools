import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Minimal .env loader — no `dotenv` dependency. Parses `KEY=VALUE` lines
 * from the repo-root `.env` into `process.env`, skipping keys already set
 * and blank/comment lines. Nothing in this repo auto-loaded `.env` before
 * this (confirmed 2026-09-10: no dotenv, no `--env-file`, no direnv) —
 * scripts needing secrets relied on the shell already having them exported.
 */
export function loadEnvFile(): void {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

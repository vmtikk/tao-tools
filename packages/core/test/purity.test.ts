import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces tao-analytics-plan.md §3: core may not import anything that
 * touches a socket or a disk. This is what makes red-green-refactor
 * possible on the pipeline — everything in core must stay a pure function
 * over plain data, testable in milliseconds.
 */
const FORBIDDEN_SPECIFIERS = [
  "node:fs",
  "node:http",
  "node:https",
  "node:net",
  "node:dgram",
  "fs",
  "http",
  "https",
  "ccxt",
  "@polkadot/api",
  "@duckdb/node-api",
];

const SRC_DIR = join(import.meta.dirname, "..", "src");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("core purity (§3 dependency rule)", () => {
  const files = listTsFiles(SRC_DIR);

  it("found source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.slice(SRC_DIR.length + 1)} imports no I/O module`, () => {
      const contents = readFileSync(file, "utf-8");
      const importSpecifiers = [...contents.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
      for (const specifier of importSpecifiers) {
        expect(FORBIDDEN_SPECIFIERS).not.toContain(specifier);
      }
    });
  }
});

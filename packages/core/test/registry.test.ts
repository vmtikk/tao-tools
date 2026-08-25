import { describe, expect, it } from "vitest";
import { MetricEntrySchema, MetricsRegistrySchema, orderByDependency, type MetricEntry } from "../src/registry/schema.js";

function entry(overrides: Partial<MetricEntry> & Pick<MetricEntry, "name">): MetricEntry {
  return {
    version: 1,
    definition: "test metric",
    params: {},
    sql: "SELECT 1",
    depends_on: [],
    changelog: [],
    export: true,
    ...overrides,
  };
}

describe("MetricEntrySchema", () => {
  it("parses a well-formed entry", () => {
    const parsed = MetricEntrySchema.parse({
      name: "price_composite_usd",
      version: 1,
      definition: "Volume-weighted composite TAO/USD close.",
      sql: "SELECT * FROM silver.ohlcv_1m",
      depends_on: [],
      changelog: [{ v1: "initial" }],
    });
    expect(parsed.params).toEqual({});
  });

  it("rejects a malformed entry with a useful error, not a runtime crash", () => {
    const result = MetricsRegistrySchema.safeParse([{ name: "missing_fields" }]);
    expect(result.success).toBe(false);
  });
});

describe("orderByDependency", () => {
  it("orders producers before consumers", () => {
    const a = entry({ name: "account_balances_daily" });
    const b = entry({ name: "wallet_count_dust_filtered", depends_on: ["account_balances_daily"] });
    const ordered = orderByDependency([b, a]);
    expect(ordered.map((e) => e.name)).toEqual(["account_balances_daily", "wallet_count_dust_filtered"]);
  });

  it("throws on an unknown dependency", () => {
    const entries = [entry({ name: "x", depends_on: ["does_not_exist"] })];
    expect(() => orderByDependency(entries)).toThrow(/unknown metric/i);
  });

  it("throws on a cycle", () => {
    const entries = [
      entry({ name: "a", depends_on: ["b"] }),
      entry({ name: "b", depends_on: ["a"] }),
    ];
    expect(() => orderByDependency(entries)).toThrow(/cycle/i);
  });
});

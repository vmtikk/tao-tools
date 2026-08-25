import { describe, expect, it } from "vitest";
import { asRao, raoToTao, RAO_PER_TAO } from "../src/types/brands.js";

describe("Rao/Tao conversion", () => {
  it("converts rao to tao at the gold export boundary", () => {
    expect(raoToTao(asRao(RAO_PER_TAO))).toBe(1);
    expect(raoToTao(asRao(RAO_PER_TAO * 9_007_199n))).toBe(9_007_199);
  });

  it("survives amounts beyond Number.MAX_SAFE_INTEGER in rao form", () => {
    const bigBalance = asRao(10_000_000n * RAO_PER_TAO); // 10M TAO in rao
    expect(bigBalance).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
    expect(raoToTao(bigBalance)).toBe(10_000_000);
  });
});

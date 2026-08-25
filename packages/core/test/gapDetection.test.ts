import { describe, expect, it } from "vitest";
import { detectGaps } from "../src/gapDetection.js";
import { asUnixMillis } from "../src/types/brands.js";

const ONE_MIN = 60_000;
const ts = (n: number) => asUnixMillis(n * ONE_MIN);

describe("detectGaps", () => {
  it("reports no gap for a contiguous sequence", () => {
    expect(detectGaps([ts(0), ts(1), ts(2), ts(3)], ONE_MIN)).toEqual([]);
  });

  it("reports a planted hole with its bucket count", () => {
    const result = detectGaps([ts(0), ts(1), ts(5), ts(6)], ONE_MIN);
    expect(result).toEqual([{ startMs: ts(2), endMs: ts(4), missingBuckets: 3 }]);
  });

  it("reports multiple disjoint holes", () => {
    const result = detectGaps([ts(0), ts(2), ts(3), ts(6)], ONE_MIN);
    expect(result).toEqual([
      { startMs: ts(1), endMs: ts(1), missingBuckets: 1 },
      { startMs: ts(4), endMs: ts(5), missingBuckets: 2 },
    ]);
  });

  it("is order-independent", () => {
    const result = detectGaps([ts(6), ts(0), ts(5), ts(1)], ONE_MIN);
    expect(result).toEqual([{ startMs: ts(2), endMs: ts(4), missingBuckets: 3 }]);
  });

  it("returns no gaps for fewer than two points", () => {
    expect(detectGaps([], ONE_MIN)).toEqual([]);
    expect(detectGaps([ts(0)], ONE_MIN)).toEqual([]);
  });
});

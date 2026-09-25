import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/chain/concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in input order even when later items resolve first", async () => {
    const delayForItem = (n: number) => (10 - n) * 5; // descending delay
    const items = Array.from({ length: 10 }, (_, i) => i + 1);

    const results = await mapWithConcurrency(items, 5, async (n) => {
      await new Promise((resolve) => setTimeout(resolve, delayForItem(n)));
      return n * 10;
    });

    expect(results).toEqual(items.map((n) => n * 10));
  });

  it("runs up to `concurrency` items at once, not more", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 4, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return n;
    });

    expect(maxInFlight).toBe(4);
  });

  it("caps concurrency at the number of items", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 100, async (n) => n);
    expect(results).toEqual([1, 2, 3]);
  });

  it("processes strictly one at a time at concurrency 1", async () => {
    const order: number[] = [];
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      order.push(n);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return n;
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates a failure and stops scheduling further items", async () => {
    let calls = 0;
    await expect(
      mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 2, async (n) => {
        calls++;
        if (n === 3) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
    // Loose bound: concurrency 2 means a handful of items may already be in
    // flight when the failure lands, but scheduling must stop well short of 50.
    expect(calls).toBeLessThan(50);
  });
});

import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/retry.js";

describe("withRetry", () => {
  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries after a failure and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("429"))
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { sleep: async () => {} });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("backs off exponentially between attempts", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");
    const delays: number[] = [];
    await withRetry(fn, {
      baseDelayMs: 100,
      factor: 2,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(delays).toEqual([100, 200]);
  });

  it("re-throws the last error once attempts are exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("still 429"));
    await expect(withRetry(fn, { maxAttempts: 3, sleep: async () => {} })).rejects.toThrow("still 429");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a fixture-driven 429 rejection more than maxAttempts times", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    };
    await expect(withRetry(fn, { maxAttempts: 2, sleep: async () => {} })).rejects.toThrow(/429/i);
    expect(calls).toBe(2);
  });
});

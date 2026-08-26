import { afterEach, describe, expect, it, vi } from "vitest";
import { createBlockmachineClient } from "../src/chain/rpcClient.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: `status ${status}`,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createBlockmachineClient (contract — fetch is mocked, never a live call)", () => {
  it("returns the RPC result on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { jsonrpc: "2.0", id: 1, result: "0xdeadbeef" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createBlockmachineClient({ apiKey: "test-key", sleep: async () => {} });
    const result = await client.call("chain_getBlockHash", [1]);

    expect(result).toBe("0xdeadbeef");
    expect(client.requestCount).toBe(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://rpc.blockmachine.io");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });

  it("throttles to maxRequestsPerMinute, waiting out the window instead of exceeding it", async () => {
    // Real Date.now()-driven, so this uses fake *timers* (which fake Date too)
    // and the client's real `sleep` (setTimeout) rather than an injected
    // instant no-op — an instant sleep with real Date.now() spins the
    // limiter's wait-loop forever, since "now" never advances between
    // iterations. Advancing fake time is what actually resolves the wait.
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { result: "ok" }));
      vi.stubGlobal("fetch", fetchMock);

      const client = createBlockmachineClient({ apiKey: "k", maxRequestsPerMinute: 1 });
      const first = client.call("chain_getBlockHash", [1]);
      await vi.advanceTimersByTimeAsync(0);
      await first;

      const second = client.call("chain_getBlockHash", [2]);
      // Second call should still be waiting for the window — not resolved yet.
      await vi.advanceTimersByTimeAsync(0);
      expect(client.requestCount).toBe(1);

      await vi.advanceTimersByTimeAsync(60_100);
      await second;

      expect(client.requestCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a 429 after the server-specified retry-after, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { error: { code: -32029, message: "rate limit exceeded", data: { retry_after_ms: 1234 } } }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { result: "0xok" }));
    vi.stubGlobal("fetch", fetchMock);
    const sleepCalls: number[] = [];
    const sleep = async (ms: number) => {
      sleepCalls.push(ms);
    };

    const client = createBlockmachineClient({ apiKey: "k", sleep });
    const result = await client.call("chain_getBlockHash", [1]);

    expect(result).toBe("0xok");
    expect(sleepCalls).toContain(1234);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to the Retry-After header (seconds) when the body carries no retry_after_ms", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, { error: { code: -32029, message: "rate limited" } }, { "retry-after": "3" }))
      .mockResolvedValueOnce(jsonResponse(200, { result: "0xok" }));
    vi.stubGlobal("fetch", fetchMock);
    const sleepCalls: number[] = [];
    const client = createBlockmachineClient({ apiKey: "k", sleep: async (ms) => void sleepCalls.push(ms) });

    await client.call("chain_getBlockHash", [1]);
    expect(sleepCalls).toContain(3000);
  });

  it("backs off and retries a non-429 failure, then gives up after its attempt budget", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);
    const client = createBlockmachineClient({ apiKey: "k", sleep: async () => {} });

    await expect(client.call("chain_getBlockHash", [1])).rejects.toThrow(/500/);
    // maxOtherAttempts = 4, so exactly 4 attempts before giving up.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws on a well-formed JSON-RPC error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { error: { code: -1, message: "bad block" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createBlockmachineClient({ apiKey: "k", sleep: async () => {} });

    await expect(client.call("chain_getBlockHash", [999999999])).rejects.toThrow(/bad block/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleTrends } from "../src/social/trendsClient.js";

function jsonResponse(body: unknown, init?: { status?: number; setCookie?: string[] }): Response {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    text: async () => `)]}',\n${JSON.stringify(body)}`,
    headers: { getSetCookie: () => init?.setCookie ?? [] },
  } as unknown as Response;
}

const EXPLORE_BODY = {
  widgets: [
    { id: "TIMESERIES", token: "tok123", request: { time: "2024-04-11 2026-09-10" } },
    { id: "GEO_MAP", token: "other", request: {} },
  ],
};

const MULTILINE_BODY = {
  default: {
    timelineData: [
      { time: "1712448000", value: [16], isPartial: false },
      { time: "1788652800", value: [27], isPartial: true },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchGoogleTrends", () => {
  it("strips the JSON safety prefix and maps timeline points, ignoring non-TIMESERIES widgets", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url.toString());
        if (url.toString().includes("/api/explore")) return jsonResponse(EXPLORE_BODY, { setCookie: ["NID=abc; Path=/"] });
        if (url.toString().includes("/api/widgetdata/multiline")) return jsonResponse(MULTILINE_BODY);
        return jsonResponse({}); // the plain explore-page cookie-priming request
      }),
    );

    const points = await fetchGoogleTrends("Bittensor", new Date("2024-04-11"), new Date("2026-09-10"));

    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("trends.google.com/trends/explore?q=");
    expect(calls[1]).toContain("/api/explore");
    expect(calls[2]).toContain("/api/widgetdata/multiline");
    expect(points).toEqual([
      { keyword: "Bittensor", weekStartMs: 1712448000000, value: 16, isPartial: false, fetchedAtMs: expect.any(Number) },
      { keyword: "Bittensor", weekStartMs: 1788652800000, value: 27, isPartial: true, fetchedAtMs: expect.any(Number) },
    ]);
  });

  it("forwards the cookie captured from earlier legs into the explore and multiline requests", async () => {
    const cookieHeaders: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, opts?: { headers?: Record<string, string> }) => {
        cookieHeaders.push(opts?.headers?.Cookie ?? null);
        if (url.toString().includes("/api/explore")) return jsonResponse(EXPLORE_BODY, { setCookie: ["NID=session-cookie; Path=/"] });
        if (url.toString().includes("/api/widgetdata/multiline")) return jsonResponse(MULTILINE_BODY);
        return jsonResponse({}, { setCookie: ["NID=session-cookie; Path=/"] });
      }),
    );

    await fetchGoogleTrends("Bittensor", new Date("2024-04-11"), new Date("2026-09-10"));

    expect(cookieHeaders[1]).toContain("NID=session-cookie");
    expect(cookieHeaders[2]).toContain("NID=session-cookie");
  });

  it("throws if the explore response has no TIMESERIES widget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.toString().includes("/api/explore")) return jsonResponse({ widgets: [] });
        return jsonResponse({});
      }),
    );

    await expect(fetchGoogleTrends("Bittensor", new Date("2024-04-11"), new Date("2026-09-10"))).rejects.toThrow(/TIMESERIES/);
  });

  it("throws with the HTTP status when explore itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.toString().includes("/api/explore")) return jsonResponse({}, { status: 429 });
        return jsonResponse({});
      }),
    );

    await expect(fetchGoogleTrends("Bittensor", new Date("2024-04-11"), new Date("2026-09-10"))).rejects.toThrow(/429/);
  });
});

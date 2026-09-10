import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchYoutubeChannelStats } from "../src/social/youtubeClient.js";
import type { YoutubeChannelConfig } from "../src/social/channels.js";

const CHANNELS: YoutubeChannelConfig[] = [
  { handle: "one", channelId: "UC_one", title: "One" },
  { handle: "two", channelId: "UC_two", title: "Two" },
];

function fakeResponse(items: unknown[]): Response {
  return { ok: true, status: 200, json: async () => ({ items }) } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchYoutubeChannelStats", () => {
  it("makes exactly one request, id-joined, for any number of channels", async () => {
    const fetchMock = vi.fn(async (url: URL) => {
      expect(url.searchParams.get("id")).toBe("UC_one,UC_two");
      expect(url.searchParams.get("key")).toBe("test-key");
      return fakeResponse([
        { id: "UC_one", snippet: { title: "One" }, statistics: { viewCount: "10", subscriberCount: "1", videoCount: "2" } },
        { id: "UC_two", snippet: { title: "Two" }, statistics: { viewCount: "20", subscriberCount: "3", videoCount: "4" } },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = await fetchYoutubeChannelStats(CHANNELS, "test-key", "2026-09-10");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      { channelId: "UC_one", handle: "one", title: "One", date: "2026-09-10", viewCount: 10, subscriberCount: 1, videoCount: 2, fetchedAtMs: expect.any(Number) },
      { channelId: "UC_two", handle: "two", title: "Two", date: "2026-09-10", viewCount: 20, subscriberCount: 3, videoCount: 4, fetchedAtMs: expect.any(Number) },
    ]);
  });

  it("throws if the API omits a configured channel from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse([{ id: "UC_one", snippet: { title: "One" }, statistics: { viewCount: "10", subscriberCount: "1", videoCount: "2" } }]),
      ),
    );

    await expect(fetchYoutubeChannelStats(CHANNELS, "test-key", "2026-09-10")).rejects.toThrow(/UC_two/);
  });

  it("throws with the API's error body on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "quota exceeded" } }) }) as unknown as Response),
    );

    await expect(fetchYoutubeChannelStats(CHANNELS, "test-key", "2026-09-10")).rejects.toThrow(/quota exceeded/);
  });
});

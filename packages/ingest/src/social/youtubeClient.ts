import { asUnixMillis, type YoutubeChannelSnapshot } from "@tao-tools/core";
import type { YoutubeChannelConfig } from "./channels.js";

interface YoutubeApiChannelItem {
  id: string;
  snippet: { title: string };
  statistics: { viewCount: string; subscriberCount: string; videoCount: string };
}

/**
 * One `channels.list` call for all configured channels at once (comma-joined
 * `id`, up to 50) — 1 quota unit total regardless of channel count, not 1
 * per channel. `part=statistics` returns cumulative counts as of the call;
 * turning those into daily deltas is silver's job (see
 * `YoutubeChannelSnapshot`'s docstring for why this API can't give deltas
 * directly).
 */
export async function fetchYoutubeChannelStats(
  channels: readonly YoutubeChannelConfig[],
  apiKey: string,
  date: string,
): Promise<YoutubeChannelSnapshot[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", channels.map((c) => c.channelId).join(","));
  url.searchParams.set("key", apiKey);

  const response = await fetch(url);
  const body = (await response.json()) as { items?: YoutubeApiChannelItem[]; error?: unknown };
  if (!response.ok) {
    throw new Error(`YouTube channels.list failed: HTTP ${response.status} — ${JSON.stringify(body.error ?? body)}`);
  }

  const byId = new Map((body.items ?? []).map((item) => [item.id, item]));
  const fetchedAtMs = asUnixMillis(Date.now());

  return channels.map((config) => {
    const item = byId.get(config.channelId);
    if (!item) {
      throw new Error(`YouTube channels.list returned no data for ${config.title} (${config.channelId})`);
    }
    return {
      channelId: config.channelId,
      handle: config.handle,
      title: item.snippet.title,
      date,
      viewCount: Number(item.statistics.viewCount),
      subscriberCount: Number(item.statistics.subscriberCount),
      videoCount: Number(item.statistics.videoCount),
      fetchedAtMs,
    };
  });
}

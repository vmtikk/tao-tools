import type { UnixMillis } from "./brands.js";

/**
 * One channel's cumulative stats at the moment of a daily poll. The YouTube
 * Data API only exposes running totals (no historical daily-delta endpoint
 * for a channel you don't own) — silver derives `views_gained`/`subs_gained`
 * by diffing consecutive snapshots of this shape, the same "snapshot and
 * diff" approach used elsewhere in this repo for balance reconstruction.
 */
export interface YoutubeChannelSnapshot {
  channelId: string;
  handle: string;
  title: string;
  /** yyyy-mm-dd, the day this snapshot represents (one row per channel per day). */
  date: string;
  viewCount: number;
  subscriberCount: number;
  videoCount: number;
  fetchedAtMs: UnixMillis;
}

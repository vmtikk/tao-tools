import type { YoutubeChannelSnapshot } from "@tao-tools/core";
import { writeRowsAsParquet, type WriteRowsAsParquetResult } from "../bronze/parquetWriter.js";
import { resolveBronzeUri as resolveDefaultBronzeUri } from "../paths.js";

function toSnakeCaseRow(row: YoutubeChannelSnapshot): Record<string, unknown> {
  return {
    channel_id: row.channelId,
    handle: row.handle,
    title: row.title,
    date: row.date,
    view_count: row.viewCount,
    subscriber_count: row.subscriberCount,
    video_count: row.videoCount,
    fetched_at_ms: row.fetchedAtMs,
  };
}

/**
 * One file per day covering every configured channel — unlike price OHLCV
 * bronze, a day's snapshot is never revisited by a later run (there's no
 * "current month" reopened the way price backfill has), so a plain
 * overwrite is correct here: no merge-with-existing needed.
 */
export async function writeYoutubeChannelStatsBronze(
  rows: readonly YoutubeChannelSnapshot[],
  date: string,
  bronzeUri?: string,
): Promise<WriteRowsAsParquetResult> {
  const uri = (bronzeUri ?? resolveDefaultBronzeUri()).replace(/\\/g, "/").replace(/\/+$/, "");
  return writeRowsAsParquet({
    rows: rows.map(toSnakeCaseRow),
    destination: `${uri}/social/youtube_channel_stats/${date}.parquet`,
  });
}

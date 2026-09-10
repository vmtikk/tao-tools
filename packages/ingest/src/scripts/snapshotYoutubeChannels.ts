import { loadEnvFile } from "../env.js";
import { YOUTUBE_CHANNELS } from "../social/channels.js";
import { fetchYoutubeChannelStats } from "../social/youtubeClient.js";
import { writeYoutubeChannelStatsBronze } from "../social/bronzeWriter.js";

/**
 * Daily poll: one `channels.list` call (1 quota unit total) for every
 * configured channel, written as one bronze row per channel for today.
 * Meant to run once a day (cron/Task Scheduler — not wired up yet); running
 * it twice in one day just overwrites today's file with the same-day
 * re-read, which is harmless but pointless.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set. See .env.example.");
    process.exit(1);
  }

  const date = new Date().toISOString().slice(0, 10);
  const snapshots = await fetchYoutubeChannelStats(YOUTUBE_CHANNELS, apiKey, date);
  const result = await writeYoutubeChannelStatsBronze(snapshots, date);

  console.log(`Wrote ${result.rowCount} rows to ${result.destination}`);
  for (const s of snapshots) {
    console.log(`  ${s.title}: ${s.viewCount} views, ${s.subscriberCount} subs, ${s.videoCount} videos`);
  }
}

main();

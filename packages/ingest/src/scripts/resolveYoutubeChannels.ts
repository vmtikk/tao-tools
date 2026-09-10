import { loadEnvFile } from "../env.js";

/**
 * One-off resolver: turns `@handle` URLs into the stable `UC...` channel IDs
 * the YouTube Data API needs for daily snapshots (handles can be reassigned;
 * channel IDs can't). Run once per new channel added to the curated list,
 * paste the printed config into `src/social/channels.ts`.
 */
const HANDLES = ["TAOTemplar", "TheTaoPod", "markjeffrey", "Opentensor", "siamkidd"];

async function main(): Promise<void> {
  loadEnvFile();
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    console.error("YOUTUBE_API_KEY is not set. See .env.example.");
    process.exit(1);
  }

  for (const handle of HANDLES) {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "snippet,statistics");
    url.searchParams.set("forHandle", handle);
    url.searchParams.set("key", apiKey);

    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      console.error(`@${handle}: HTTP ${response.status} — ${JSON.stringify(body)}`);
      continue;
    }
    const channel = body.items?.[0];
    if (!channel) {
      console.error(`@${handle}: no channel found`);
      continue;
    }
    console.log(
      `{ handle: "${handle}", channelId: "${channel.id}", title: ${JSON.stringify(channel.snippet.title)} }, ` +
        `// viewCount=${channel.statistics.viewCount} subs=${channel.statistics.subscriberCount}`,
    );
  }
}

main();

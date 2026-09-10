/**
 * Curated Bittensor-related YouTube channels (user-picked, not derived —
 * mirrors `exchanges/venues.ts`'s "config, not discovery" shape). Channel
 * IDs resolved 2026-09-10 via `youtube:resolve-channels` from the handles
 * given at the time; re-run that script if a handle here ever needs
 * re-resolving (handles can be reassigned, channel IDs can't).
 */
export interface YoutubeChannelConfig {
  handle: string;
  channelId: string;
  title: string;
}

export const YOUTUBE_CHANNELS: YoutubeChannelConfig[] = [
  { handle: "TAOTemplar", channelId: "UC92OMuTHmkrk0Crz5Xqi-5w", title: "TAO Templar" },
  { handle: "TheTaoPod", channelId: "UCopT5-KoQVINacqYAJsvfTg", title: "The TAO Pod" },
  { handle: "markjeffrey", channelId: "UCjw0PV30AxyJMYoXBBu8obg", title: "Hash Rate Podcast" },
  { handle: "Opentensor", channelId: "UCq-UgxLUK1mYJBxrmOfP7aA", title: "The Opentensor Foundation | Bittensor TAO" },
  { handle: "siamkidd", channelId: "UCFXbU_jqaxaOJmAT5fBaQfg", title: "Siam Kidd" },
];

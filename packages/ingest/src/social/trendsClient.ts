import { asUnixMillis, type GoogleTrendsPoint } from "@tao-tools/core";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/** Google prefixes every trends.google.com/api/* JSON response with this
 * anti-JS-hijacking guard — strip it before parsing. */
function stripJsonSafetyPrefix(text: string): string {
  return text.replace(/^\)\]\}'[,]?\s*/, "");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

class CookieJar {
  private readonly byName = new Map<string, string>();

  absorb(response: Response): void {
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookie) {
      const pair = cookie.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.byName.set(pair.slice(0, eq), pair);
    }
  }

  header(): string {
    return [...this.byName.values()].join("; ");
  }
}

interface TimelinePoint {
  time: string;
  value: number[];
  isPartial?: boolean;
}

interface ExploreWidget {
  id: string;
  token: string;
  request: unknown;
}

/**
 * Fetches Google's "interest over time" for one keyword, worldwide, as
 * weekly points across `[startDate, endDate]` — via the same unofficial,
 * undocumented endpoints `pytrends` wraps (there is no official Trends API
 * for third-party use). Reverse-engineered and confirmed working manually
 * 2026-09-10; can start returning HTML error pages instead of JSON at any
 * time if Google changes the frontend — this is the flakiest data source in
 * the repo, expect it to need attention again eventually.
 *
 * Three sequential legs, and this is the reconstructed reason each exists:
 * 1. A plain page load of the public explore UI, purely to receive an `NID`
 *    session cookie — the API legs 401/429 immediately without one, even
 *    though this leg itself commonly returns 429 (the cookie still arrives
 *    on the error response, so the 429 here is not fatal).
 * 2. `api/explore` — given the keyword and date range, returns a per-widget
 *    request payload and a one-time `token` for the timeseries widget.
 *    Google decides the resolution here (`WEEK` for the ~2.4 year range
 *    this repo queries, matching the `_weekly` gold rollups already used
 *    for price); ranges over ~9 months always get downsampled below daily
 *    regardless of what's asked for, and there's no override.
 * 3. `api/widgetdata/multiline` — the actual series, using that request +
 *    token verbatim.
 *
 * The 0-100 scale is normalized to the peak *within this query's date
 * range*, not an absolute measure — re-running this later with a later
 * `endDate` re-normalizes the whole series against a new peak, so an old
 * week's value can legitimately shift between two fetches. Each fetch's
 * points carry their own `fetchedAtMs` (see `GoogleTrendsPoint`) so that's
 * traceable rather than silently overwriting history with a different scale.
 */
export async function fetchGoogleTrends(keyword: string, startDate: Date, endDate: Date): Promise<GoogleTrendsPoint[]> {
  const jar = new CookieJar();
  const exploreUiUrl = `https://trends.google.com/trends/explore?q=${encodeURIComponent(keyword)}`;

  const homeResponse = await fetch(exploreUiUrl, { headers: { "User-Agent": USER_AGENT } });
  jar.absorb(homeResponse);

  const exploreReq = {
    comparisonItem: [{ keyword, geo: "", time: `${formatDate(startDate)} ${formatDate(endDate)}` }],
    category: 0,
    property: "",
  };
  const exploreUrl = `https://trends.google.com/trends/api/explore?hl=en-US&tz=0&req=${encodeURIComponent(JSON.stringify(exploreReq))}`;
  const exploreResponse = await fetch(exploreUrl, {
    headers: { "User-Agent": USER_AGENT, Cookie: jar.header(), Referer: exploreUiUrl },
  });
  jar.absorb(exploreResponse);
  if (!exploreResponse.ok) {
    throw new Error(`Google Trends explore failed: HTTP ${exploreResponse.status}`);
  }
  const exploreBody = JSON.parse(stripJsonSafetyPrefix(await exploreResponse.text())) as { widgets: ExploreWidget[] };
  const widget = exploreBody.widgets.find((w) => w.id === "TIMESERIES");
  if (!widget) {
    throw new Error("Google Trends explore response had no TIMESERIES widget");
  }

  const multilineUrl =
    `https://trends.google.com/trends/api/widgetdata/multiline?hl=en-US&tz=0` +
    `&req=${encodeURIComponent(JSON.stringify(widget.request))}&token=${widget.token}`;
  const multilineResponse = await fetch(multilineUrl, {
    headers: { "User-Agent": USER_AGENT, Cookie: jar.header(), Referer: exploreUiUrl },
  });
  if (!multilineResponse.ok) {
    throw new Error(`Google Trends widgetdata failed: HTTP ${multilineResponse.status}`);
  }
  const multilineBody = JSON.parse(stripJsonSafetyPrefix(await multilineResponse.text())) as {
    default: { timelineData: TimelinePoint[] };
  };

  const fetchedAtMs = asUnixMillis(Date.now());
  return multilineBody.default.timelineData.map((point) => ({
    keyword,
    weekStartMs: asUnixMillis(Number(point.time) * 1000),
    value: point.value[0] ?? 0,
    isPartial: point.isPartial ?? false,
    fetchedAtMs,
  }));
}

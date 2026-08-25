"use client";

import type { GoldSeriesPoint } from "@tao-tools/core";
import { PriceChart } from "./PriceChart";
import { useLiveTicker } from "../lib/useLiveTicker";
import { formatUsd } from "../lib/format";

export function LiveUsdPriceChart({ points }: { points: GoldSeriesPoint[] }) {
  const live = useLiveTicker("TAO/USD");

  return (
    <div>
      <PriceChart
        points={points}
        unit="usd"
        ariaLabel="TAO/USD composite price line chart"
        livePoint={live ? { timestampMs: live.timestampMs, value: live.price } : null}
      />
      {live && (
        <p className="live-badge">
          <span className="live-dot" aria-hidden="true" /> LIVE {formatUsd(live.price)} · Kraken
        </p>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { GoldSeriesPoint } from "@tao-tools/core";
import { niceTicks } from "../lib/niceTicks";
import { formatTime, formatCount } from "../lib/format";

const WIDTH = 960;
const HEIGHT = 280;
const MARGIN = { top: 16, right: 40, bottom: 28, left: 8 };

/**
 * Transfer count per block (tao-analytics-plan.md §6, Phase 2.1 tracer
 * bullet). Same bar-chart shape as VolumeChart — a count-per-bucket series —
 * but x is per-block (seconds apart, not per-day), so the tooltip uses a
 * time-of-day formatter instead of a date-only one.
 */
export function TransferCountChart({ points }: { points: GoldSeriesPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { bars, xScale, yScale, yTicks, plotLeft, plotRight, plotTop, plotBottom, barWidth } = useMemo(() => {
    const plotLeft = MARGIN.left;
    const plotRight = WIDTH - MARGIN.right;
    const plotTop = MARGIN.top;
    const plotBottom = HEIGHT - MARGIN.bottom;

    const xs = points.map((p) => p.timestampMs);
    const ys = points.map((p) => p.value);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMax = Math.max(...ys, 0);

    const yTicks = niceTicks(0, yMax || 1, 4);
    const yTop = yTicks.at(-1)!;

    const xScale = (t: number) =>
      xMax === xMin ? (plotLeft + plotRight) / 2 : plotLeft + ((t - xMin) / (xMax - xMin)) * (plotRight - plotLeft);
    const yScale = (v: number) => plotBottom - (v / (yTop || 1)) * (plotBottom - plotTop);

    const barWidth = Math.min(24, Math.max(2, ((plotRight - plotLeft) / (points.length || 1)) * 0.7));

    const bars = points.map((p) => ({
      x: Math.min(plotRight - barWidth, Math.max(plotLeft, xScale(p.timestampMs) - barWidth / 2)),
      y: yScale(p.value),
      height: plotBottom - yScale(p.value),
      point: p,
    }));

    return { bars, xScale, yScale, yTicks, plotLeft, plotRight, plotTop, plotBottom, barWidth };
  }, [points]);

  if (points.length === 0) {
    return (
      <p className="chart-empty">
        No transfers in this range — run <code>pnpm chain:ingest</code>, then <code>pnpm chain:materialize-silver</code>{" "}
        and <code>pnpm pipeline:materialize</code>.
      </p>
    );
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let nearestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(xScale(p.timestampMs) - px);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }

  return (
    <div className="chart-root">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label="Transfer count per block bar chart"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line x1={plotLeft} x2={plotRight} y1={yScale(tick)} y2={yScale(tick)} className="gridline" />
            <text x={plotRight + 8} y={yScale(tick)} dy="0.32em" className="axis-label">
              {formatCount(tick)}
            </text>
          </g>
        ))}

        <line x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} className="baseline" />

        {bars.map((bar, i) => (
          <rect
            key={bar.point.timestampMs}
            x={bar.x}
            y={bar.y}
            width={barWidth}
            height={Math.max(0, bar.height)}
            className={i === hoverIndex ? "volume-bar volume-bar-hovered" : "volume-bar"}
          />
        ))}
      </svg>

      {hovered && (
        <div className="tooltip" style={{ left: `${(xScale(hovered.timestampMs) / WIDTH) * 100}%` }}>
          <div className="tooltip-time">{formatTime(hovered.timestampMs)}</div>
          <div className="tooltip-value">{formatCount(hovered.value)} transfers</div>
        </div>
      )}
    </div>
  );
}

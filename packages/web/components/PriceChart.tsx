"use client";

import { useMemo, useState } from "react";
import type { GoldSeriesPoint } from "@tao-tools/core";
import { niceTicks } from "../lib/niceTicks";
import { formatBtc, formatTime, formatUsd } from "../lib/format";

const WIDTH = 960;
const HEIGHT = 360;
const MARGIN = { top: 16, right: 56, bottom: 28, left: 8 };

export interface LivePoint {
  timestampMs: number;
  value: number;
}

export interface PriceChartProps {
  points: GoldSeriesPoint[];
  /** Picks the formatter internally rather than accepting one as a prop —
   * a function prop can't cross the server/client component boundary
   * (page.tsx renders this from a Server Component), so the choice has to
   * stay a serializable string. */
  unit?: "usd" | "btc";
  ariaLabel?: string;
  /** Rightmost-pixel live edge (tao-analytics-plan.md §9, §10) — rendered as
   * a distinct pulsing marker past the static series, never folded into the
   * historical line itself. */
  livePoint?: LivePoint | null;
}

export function PriceChart({ points, unit = "usd", ariaLabel = "Price line chart", livePoint = null }: PriceChartProps) {
  const valueFormatter = unit === "btc" ? formatBtc : formatUsd;
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const { path, xScale, yScale, yTicks, plotLeft, plotRight, plotTop, plotBottom } = useMemo(() => {
    const plotLeft = MARGIN.left;
    const plotRight = WIDTH - MARGIN.right;
    const plotTop = MARGIN.top;
    const plotBottom = HEIGHT - MARGIN.bottom;

    const xs: number[] = points.map((p) => Number(p.timestampMs));
    const ys: number[] = points.map((p) => p.value);
    if (livePoint) {
      xs.push(livePoint.timestampMs);
      ys.push(livePoint.value);
    }
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMinRaw = Math.min(...ys);
    const yMaxRaw = Math.max(...ys);
    const yPad = (yMaxRaw - yMinRaw) * 0.1 || yMaxRaw * 0.05 || 1;

    const yTicks = niceTicks(yMinRaw - yPad, yMaxRaw + yPad, 5);
    const yMin = yTicks[0]!;
    const yMax = yTicks.at(-1)!;

    // A single point (or a degenerate xMin===xMax range) has no span to
    // interpolate across — center it instead of collapsing to plotLeft.
    const xScale = (t: number) =>
      xMax === xMin ? (plotLeft + plotRight) / 2 : plotLeft + ((t - xMin) / (xMax - xMin)) * (plotRight - plotLeft);
    const yScale = (v: number) => plotBottom - ((v - yMin) / (yMax - yMin || 1)) * (plotBottom - plotTop);

    const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.timestampMs)} ${yScale(p.value)}`).join(" ");

    return { path, xScale, yScale, yTicks, plotLeft, plotRight, plotTop, plotBottom };
  }, [points, livePoint]);

  if (points.length === 0) {
    return <p className="chart-empty">No data yet — run the ingest and pipeline scripts.</p>;
  }

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const last = points.at(-1)!;

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
        aria-label={ariaLabel}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={plotLeft}
              x2={plotRight}
              y1={yScale(tick)}
              y2={yScale(tick)}
              className="gridline"
            />
            <text x={plotRight + 8} y={yScale(tick)} dy="0.32em" className="axis-label">
              {valueFormatter(tick)}
            </text>
          </g>
        ))}

        <line x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} className="baseline" />

        <path d={path} className="series-line" fill="none" strokeLinecap="round" strokeLinejoin="round" />

        <circle cx={xScale(last.timestampMs)} cy={yScale(last.value)} r={4} className="end-marker" />
        <text x={xScale(last.timestampMs) - 8} y={yScale(last.value) - 10} className="end-label" textAnchor="end">
          {valueFormatter(last.value)}
        </text>

        {livePoint && (
          <g>
            <circle cx={xScale(livePoint.timestampMs)} cy={yScale(livePoint.value)} r={9} className="live-marker-pulse" />
            <circle cx={xScale(livePoint.timestampMs)} cy={yScale(livePoint.value)} r={4} className="live-marker" />
          </g>
        )}

        {hovered && (
          <g>
            <line
              x1={xScale(hovered.timestampMs)}
              x2={xScale(hovered.timestampMs)}
              y1={plotTop}
              y2={plotBottom}
              className="crosshair"
            />
            <circle
              cx={xScale(hovered.timestampMs)}
              cy={yScale(hovered.value)}
              r={4}
              className="hover-dot"
            />
          </g>
        )}
      </svg>

      {hovered && (
        <div
          className="tooltip"
          style={{ left: `${(xScale(hovered.timestampMs) / WIDTH) * 100}%` }}
        >
          <div className="tooltip-time">{formatTime(hovered.timestampMs)}</div>
          <div className="tooltip-value">{valueFormatter(hovered.value)}</div>
        </div>
      )}

      <button type="button" className="table-toggle" onClick={() => setShowTable((v) => !v)}>
        {showTable ? "Hide table view" : "View as table"}
      </button>

      {showTable && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.timestampMs}>
                  <td>{formatTime(p.timestampMs)}</td>
                  <td>{valueFormatter(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

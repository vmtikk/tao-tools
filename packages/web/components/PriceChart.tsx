"use client";

import { useMemo, useState } from "react";
import type { GoldSeriesPoint } from "@tao-tools/core";
import { niceTicks } from "../lib/niceTicks";

const WIDTH = 960;
const HEIGHT = 360;
const MARGIN = { top: 16, right: 56, bottom: 28, left: 8 };

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PriceChart({ points }: { points: GoldSeriesPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  const { path, xScale, yScale, yTicks, plotLeft, plotRight, plotTop, plotBottom } = useMemo(() => {
    const plotLeft = MARGIN.left;
    const plotRight = WIDTH - MARGIN.right;
    const plotTop = MARGIN.top;
    const plotBottom = HEIGHT - MARGIN.bottom;

    const xs = points.map((p) => p.timestampMs);
    const ys = points.map((p) => p.value);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMinRaw = Math.min(...ys);
    const yMaxRaw = Math.max(...ys);
    const yPad = (yMaxRaw - yMinRaw) * 0.1 || yMaxRaw * 0.05 || 1;

    const yTicks = niceTicks(yMinRaw - yPad, yMaxRaw + yPad, 5);
    const yMin = yTicks[0]!;
    const yMax = yTicks.at(-1)!;

    const xScale = (t: number) => plotLeft + ((t - xMin) / (xMax - xMin || 1)) * (plotRight - plotLeft);
    const yScale = (v: number) => plotBottom - ((v - yMin) / (yMax - yMin || 1)) * (plotBottom - plotTop);

    const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.timestampMs)} ${yScale(p.value)}`).join(" ");

    return { path, xScale, yScale, yTicks, plotLeft, plotRight, plotTop, plotBottom };
  }, [points]);

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
        aria-label="TAO/USD composite price line chart"
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
              {formatUsd(tick)}
            </text>
          </g>
        ))}

        <line x1={plotLeft} x2={plotRight} y1={plotBottom} y2={plotBottom} className="baseline" />

        <path d={path} className="series-line" fill="none" strokeLinecap="round" strokeLinejoin="round" />

        <circle cx={xScale(last.timestampMs)} cy={yScale(last.value)} r={4} className="end-marker" />
        <text x={xScale(last.timestampMs) - 8} y={yScale(last.value) - 10} className="end-label" textAnchor="end">
          {formatUsd(last.value)}
        </text>

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
          <div className="tooltip-value">{formatUsd(hovered.value)}</div>
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
                <th>TAO/USD</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.timestampMs}>
                  <td>{formatTime(p.timestampMs)}</td>
                  <td>{formatUsd(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

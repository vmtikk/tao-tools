"use client";

import { useEffect, useRef, useState } from "react";

export interface LiveTick {
  price: number;
  timestampMs: number;
}

interface KrakenTickerFrame {
  channel?: string;
  type?: string;
  data?: Array<{ symbol?: string; last?: number }>;
}

/**
 * Rightmost-pixel live edge (tao-analytics-plan.md §9, §10 known traps —
 * "the site never queries anything at runtime" for anything historical).
 * Connects straight from the browser to Kraken's public ticker websocket —
 * no API key, no server involvement, no cost. Reconnects with exponential
 * backoff on drop; a failure here degrades to "no live badge", never a
 * broken page, since the static chart already rendered from gold.json.
 */
export function useLiveTicker(symbol: string): LiveTick | null {
  const [tick, setTick] = useState<LiveTick | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    let closedByCleanup = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      socket = new WebSocket("wss://ws.kraken.com/v2");

      socket.onopen = () => {
        attemptRef.current = 0;
        socket?.send(JSON.stringify({ method: "subscribe", params: { channel: "ticker", symbol: [symbol] } }));
      };

      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as KrakenTickerFrame;
          const last = frame.data?.[0]?.last;
          if (typeof last === "number") {
            setTick({ price: last, timestampMs: Date.now() });
          }
        } catch {
          // Non-ticker frame (heartbeat, subscription ack) — not an error.
        }
      };

      socket.onclose = () => {
        if (closedByCleanup) return;
        const delayMs = Math.min(30_000, 1000 * 2 ** attemptRef.current);
        attemptRef.current += 1;
        reconnectTimer = setTimeout(connect, delayMs);
      };

      socket.onerror = () => socket?.close();
    }

    connect();

    return () => {
      closedByCleanup = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [symbol]);

  return tick;
}

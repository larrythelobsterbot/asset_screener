"use client";

// Shared client hook for the attention radar data. Several surfaces
// (screener table chips, heatmap tile badges, macro-bar movers, asset
// panel) want the same symbol → {accel, klass} lookup; each mounts this
// hook independently and the server route's 5-min cache makes the
// duplicate fetches effectively free.

import { useEffect, useState } from "react";
import type { MomentumResponse } from "@/app/api/social/momentum/route";

export interface AttentionEntry {
  accel: number;
  klass: string | null;
  mentions: number;
  isHL: boolean;
  series: number[];
}

const POLL_MS = 5 * 60_000;

export function useAttention(): {
  bySymbol: Map<string, AttentionEntry>;
  top: Array<{ symbol: string } & AttentionEntry>;
  stale: boolean;
} {
  const [state, setState] = useState<{
    bySymbol: Map<string, AttentionEntry>;
    top: Array<{ symbol: string } & AttentionEntry>;
    stale: boolean;
  }>({ bySymbol: new Map(), top: [], stale: false });

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetch("/api/social/momentum")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: MomentumResponse | null) => {
          if (cancelled || !d || !Array.isArray(d.data)) return;
          const bySymbol = new Map<string, AttentionEntry>();
          const top: Array<{ symbol: string } & AttentionEntry> = [];
          for (const row of d.data) {
            const entry: AttentionEntry = {
              accel: row.accel,
              klass: row.klass,
              mentions: row.mentions,
              isHL: row.isHL,
              series: row.series,
            };
            bySymbol.set(row.symbol, entry);
            // "Top movers" = classified rows only (the route already
            // ranks classified-first, accel-desc within each group).
            if (row.klass) top.push({ symbol: row.symbol, ...entry });
          }
          setState({ bySymbol, top, stale: d.stale });
        })
        .catch(() => {
          /* keep last known */
        });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}

// Chip tone per attention class — shared so table chips, tile badges,
// and the macro strip stay visually consistent.
export function attentionTone(klass: string | null): "warn" | "up" | "down" | null {
  switch (klass) {
    case "quiet_accumulation":
    case "accelerating":
      return "warn";
    case "confirmed_move":
      return "up";
    case "hollow_pump":
      return "down";
    default:
      return null;
  }
}

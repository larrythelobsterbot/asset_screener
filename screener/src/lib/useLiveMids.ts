"use client";

// Client hook for the /api/stream/mids SSE feed. Returns live mids plus a
// per-symbol tick direction ("up" | "down" | null) that flips on each
// change — drives the price-tick pulse animation in the terminal. The
// direction is cleared after a short decay so the UI pulses on the tick
// rather than staying permanently colored.
//
// EventSource auto-reconnects on drops; we re-subscribe when the symbol
// set changes (keyed by the joined string to avoid effect churn).

import { useEffect, useRef, useState } from "react";

export interface LiveMid {
  mid: number;
  dir: "up" | "down" | null;
}

const DIR_DECAY_MS = 900;

export function useLiveMids(symbols?: string[]): Record<string, LiveMid> {
  const [mids, setMids] = useState<Record<string, LiveMid>>({});
  const prevRef = useRef<Record<string, number>>({});
  const decayTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const key = symbols && symbols.length ? [...symbols].sort().join(",") : "";

  useEffect(() => {
    const qs = key ? `?symbols=${encodeURIComponent(key)}` : "";
    const es = new EventSource(`/api/stream/mids${qs}`);
    const timers = decayTimers.current;

    es.onmessage = (ev) => {
      let data: Record<string, number>;
      try { data = JSON.parse(ev.data); } catch { return; }
      setMids((prev) => {
        const next = { ...prev };
        for (const [sym, mid] of Object.entries(data)) {
          const old = prevRef.current[sym];
          let dir: "up" | "down" | null = next[sym]?.dir ?? null;
          if (old != null && mid !== old) {
            dir = mid > old ? "up" : "down";
            // Decay the tick highlight back to neutral.
            if (timers[sym]) clearTimeout(timers[sym]);
            timers[sym] = setTimeout(() => {
              setMids((m) => (m[sym] ? { ...m, [sym]: { ...m[sym], dir: null } } : m));
            }, DIR_DECAY_MS);
          }
          prevRef.current[sym] = mid;
          next[sym] = { mid, dir };
        }
        return next;
      });
    };

    return () => {
      es.close();
      for (const t of Object.values(timers)) clearTimeout(t);
    };
  }, [key]);

  return mids;
}

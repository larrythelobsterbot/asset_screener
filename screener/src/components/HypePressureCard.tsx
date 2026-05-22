"use client";

// Small dashboard card mirroring the layout from hypurrscan.io/dashboard:
//
//   ┌────────────────────────────────────────┐
//   │ TWAPs HYPE Buy Pressure                │
//   │ Next 1h:           +$533,213           │
//   │ Next 24h:          +$4,948,460         │
//   └────────────────────────────────────────┘
//
// Polls /api/hype/pressure every 60s. Backend caches at 60s + the
// poller writes snapshots every 90s, so this is essentially free
// downstream after the first hit. Card highlights mustard when the
// 1h pressure is above the alert threshold.

import { useEffect, useState } from "react";
import type { PressureResponse } from "@/app/api/hype/pressure/route";

function fmtUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${Math.round(abs / 1e3).toLocaleString()}K`;
  return `${sign}$${Math.round(abs).toLocaleString()}`;
}

function tone(n: number): "up" | "down" | "flat" {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

export default function HypePressureCard() {
  const [data, setData] = useState<PressureResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => fetch("/api/hype/pressure")
      .then((r) => r.ok ? r.json() : null)
      .then((d: PressureResponse | null) => { if (!cancelled && d) setData(d); })
      .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const t1h = data ? tone(data.pressure_1h_usd) : "flat";
  const t24h = data ? tone(data.pressure_24h_usd) : "flat";
  const alertHot = data
    ? data.pressure_1h_usd >= data.threshold_usd
    : false;

  return (
    <div className="hp-card">
      <div className="hp-head">
        <span className="hp-title">TWAPs HYPE Buy Pressure</span>
        {data && (
          <span className="hp-meta">
            HYPE ${data.hype_price.toFixed(2)} · {data.active_twap_count} active
          </span>
        )}
      </div>
      <div className="hp-row">
        <span className="hp-label">Next 1h</span>
        <span
          className={`hp-val tone-${t1h}`}
          style={alertHot ? {
            background: "color-mix(in oklab, var(--acc-warn) 16%, transparent)",
            color: "var(--acc-warn)",
            padding: "1px 6px",
            borderRadius: 3,
          } : undefined}
        >
          {data ? fmtUsd(data.pressure_1h_usd) : "—"}
        </span>
      </div>
      <div className="hp-row">
        <span className="hp-label">Next 24h</span>
        <span className={`hp-val tone-${t24h}`}>
          {data ? fmtUsd(data.pressure_24h_usd) : "—"}
        </span>
      </div>
      <style jsx>{`
        .hp-card {
          background: var(--bg-card);
          border: .5px solid var(--border);
          border-radius: var(--radius);
          padding: 10px 14px;
          min-width: 280px;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        .hp-head {
          display: flex; justify-content: space-between; align-items: baseline;
          margin-bottom: 8px;
          padding-bottom: 6px;
          border-bottom: .5px solid var(--border-soft);
        }
        .hp-title {
          font-size: 11px; font-weight: 600;
          letter-spacing: .12em; text-transform: uppercase;
          color: var(--text);
        }
        .hp-meta {
          font-size: 9px; color: var(--text-mute);
          letter-spacing: .04em;
        }
        .hp-row {
          display: flex; justify-content: space-between; align-items: baseline;
          padding: 3px 0;
          font-size: 12px;
        }
        .hp-label {
          color: var(--text-mute);
          font-size: 11px;
        }
        .hp-val {
          font-weight: 500;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}

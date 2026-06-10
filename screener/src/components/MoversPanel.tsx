"use client";

// Right rail of /terminal — the "Radar". For now it surfaces top movers
// among liquid perps (the fastest read on where intraday action is), with
// a 1h/4h/24h horizon toggle tuned for day-trading. Phase 2 stacks OI-delta
// / funding / liquidation cards above this from /api/derivs.
//
// Clicking a symbol filters the feed (cross-link via onPickSymbol), so you
// can jump from "DOGE is +9% on 1h" straight to the catalyst stream.

import { useEffect, useMemo, useState } from "react";
import type { AssetData } from "@/lib/types";

const POLL_MS = 30_000;
const MIN_VOL_24H = 5_000_000; // ignore illiquid perps — noise at 20x
const TOP_N = 12;

type Horizon = "1h" | "4h" | "24h";

function changeFor(a: AssetData, h: Horizon): number | null {
  return h === "1h" ? a.change1h : h === "4h" ? a.change4h : a.change24h;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export default function MoversPanel({
  symbol,
  onPickSymbol,
}: {
  symbol?: string | null;
  onPickSymbol?: (s: string | null) => void;
}) {
  const [assets, setAssets] = useState<AssetData[]>([]);
  const [horizon, setHorizon] = useState<Horizon>("1h");

  useEffect(() => {
    let cancelled = false;
    const tick = () => fetch("/api/markets")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AssetData[] | null) => { if (!cancelled && d) setAssets(d); })
      .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const { gainers, losers } = useMemo(() => {
    const liquid = assets.filter(
      (a) => a.source === "hyperliquid" && a.volume24h >= MIN_VOL_24H && changeFor(a, horizon) != null
    );
    const sorted = [...liquid].sort((a, b) => (changeFor(b, horizon)! - changeFor(a, horizon)!));
    return {
      gainers: sorted.slice(0, TOP_N),
      losers: sorted.slice(-TOP_N).reverse(),
    };
  }, [assets, horizon]);

  const renderRow = (a: AssetData) => {
    const c = changeFor(a, horizon);
    const tone = c == null ? "flat" : c > 0 ? "up" : c < 0 ? "down" : "flat";
    return (
      <button
        key={a.symbol}
        className={`mv-row ${a.symbol === symbol ? "sel" : ""}`}
        onClick={() => onPickSymbol?.(a.symbol === symbol ? null : a.symbol)}
        title={`${a.name} · vol $${(a.volume24h / 1e6).toFixed(1)}M`}
      >
        <span className="mv-sym">{a.symbol}</span>
        <span className={`mv-pct tone-${tone}`}>{fmtPct(c)}</span>
      </button>
    );
  };

  return (
    <div className="radar">
      <div className="radar-bar">
        <span className="radar-title">MOVERS</span>
        <div className="seg">
          {(["1h", "4h", "24h"] as Horizon[]).map((h) => (
            <button key={h} className={horizon === h ? "on" : ""} onClick={() => setHorizon(h)}>
              {h.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="radar-body">
        <div className="mv-head up">▲ GAINERS</div>
        {gainers.map(renderRow)}
        <div className="mv-head down">▼ LOSERS</div>
        {losers.map(renderRow)}
        {assets.length === 0 && <div className="radar-empty">loading…</div>}
      </div>

      <style jsx>{`
        .radar {
          display: flex; flex-direction: column;
          height: 100%;
          background: var(--bg-card);
          overflow: hidden;
          font-family: var(--font-geist-mono), monospace;
        }
        .radar-bar {
          display: flex; align-items: center; justify-content: space-between;
          padding: 8px 12px;
          border-bottom: .5px solid var(--border-soft);
          flex: 0 0 auto;
        }
        .radar-title {
          font-size: 11px; font-weight: 600; letter-spacing: .14em;
          color: var(--text-strong);
        }
        .seg { display: flex; gap: 2px; }
        .seg > button {
          font-size: 10px; letter-spacing: .06em;
          padding: 2px 6px;
          background: var(--bg-chip);
          border: .5px solid var(--border);
          border-radius: var(--radius);
          color: var(--text-mute);
          cursor: pointer;
          font-family: inherit;
        }
        .seg > button:hover { color: var(--text); }
        .seg > button.on {
          color: var(--acc-warn);
          border-color: color-mix(in oklab, var(--acc-warn) 40%, transparent);
          background: var(--bg-elev);
        }
        .radar-body { overflow-y: auto; flex: 1 1 auto; padding: 4px 0; }
        .radar-empty { padding: 16px; text-align: center; color: var(--text-mute); font-size: 11px; }
        .mv-head {
          font-size: 9px; letter-spacing: .12em;
          padding: 8px 12px 4px;
          color: var(--text-mute);
        }
        .mv-head.up { color: color-mix(in oklab, var(--acc-up) 70%, var(--text-mute)); }
        .mv-head.down { color: color-mix(in oklab, var(--acc-down) 70%, var(--text-mute)); }
        .mv-row {
          display: flex; justify-content: space-between; align-items: baseline;
          width: 100%;
          padding: 3px 12px;
          background: transparent; border: none;
          cursor: pointer;
          font-family: inherit;
          font-size: 12px;
        }
        .mv-row:hover { background: var(--bg-row-h); }
        .mv-row.sel { background: color-mix(in oklab, var(--acc-warn) 8%, transparent); }
        .mv-sym { color: var(--text); letter-spacing: .03em; }
        .mv-row.sel .mv-sym { color: var(--acc-warn); }
        .mv-pct { font-variant-numeric: tabular-nums; }
        .tone-up { color: var(--acc-up); }
        .tone-down { color: var(--acc-down); }
        .tone-flat { color: var(--text-mute); }
      `}</style>
    </div>
  );
}

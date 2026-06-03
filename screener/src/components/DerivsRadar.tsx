"use client";

// Phase 2 "Radar" — cross-exchange derivatives positioning per coin.
// Reads /api/derivs (written by the Coinalyze poller). Each row shows the
// OI×Price regime, aggregate OI + its delta, HL funding, and recent
// liquidations — the positioning/flow read that matters for 20x intraday.
//
// Sort: FLOW (by |ΔOI|, surfaces where positioning is shifting now) or
// SIZE (by absolute OI). Click a coin to cross-filter the feed.

import { useEffect, useMemo, useState } from "react";
import type { DerivsItem } from "@/app/api/derivs/route";

const POLL_MS = 20_000;

const REGIME: Record<string, { label: string; tone: "up" | "down" | "warn" | "flat" }> = {
  short_squeeze: { label: "SQUEEZE ↑", tone: "up" },
  new_longs: { label: "NEW LONGS", tone: "up" },
  new_shorts: { label: "NEW SHORTS", tone: "down" },
  long_flush: { label: "FLUSH ↓", tone: "down" },
  flat: { label: "—", tone: "flat" },
};

function fmtUsd(n: number | null): string {
  if (n == null) return "—";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
}
function fmtPct(n: number | null, dp = 1): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`;
}
function tone(n: number | null): "up" | "down" | "flat" {
  if (n == null || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

export default function DerivsRadar({
  symbol,
  onPickSymbol,
}: {
  symbol?: string | null;
  onPickSymbol?: (s: string | null) => void;
}) {
  const [items, setItems] = useState<DerivsItem[]>([]);
  const [sort, setSort] = useState<"flow" | "size">("flow");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () => fetch("/api/derivs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items: DerivsItem[] } | null) => {
        if (!cancelled && d?.items) { setItems(d.items); setReady(true); }
      })
      .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const sorted = useMemo(() => {
    const arr = [...items];
    if (sort === "flow") arr.sort((a, b) => Math.abs(b.oiDeltaPct ?? 0) - Math.abs(a.oiDeltaPct ?? 0));
    else arr.sort((a, b) => (b.oiUsd ?? 0) - (a.oiUsd ?? 0));
    return arr;
  }, [items, sort]);

  return (
    <div className="radar">
      <div className="radar-bar">
        <span className="radar-title">RADAR</span>
        <span className="radar-sub">OI · FUNDING · LIQ</span>
        <div className="seg">
          {(["flow", "size"] as const).map((s) => (
            <button key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="radar-body">
        {!ready && <div className="radar-empty">loading derivs…</div>}
        {ready && sorted.length === 0 && (
          <div className="radar-empty">warming up — first regime read needs ~15m of history</div>
        )}
        {sorted.map((d) => {
          const reg = REGIME[d.regime ?? "flat"] ?? REGIME.flat;
          const liqNet = (d.liqLongUsd ?? 0) - (d.liqShortUsd ?? 0); // >0: longs rekt
          const liqTotal = (d.liqLongUsd ?? 0) + (d.liqShortUsd ?? 0);
          const fundAnnual = d.fundingHl != null ? d.fundingHl * 24 * 365 * 100 : null;
          return (
            <button
              key={d.base}
              className={`row ${d.base === symbol ? "sel" : ""}`}
              onClick={() => onPickSymbol?.(d.base === symbol ? null : d.base)}
              title={d.venues ? `OI aggregated across ${d.venues} venues` : undefined}
            >
              <div className="r1">
                <span className="sym">{d.base}</span>
                <span className={`px tone-${tone(d.priceDeltaPct)}`}>{fmtPct(d.priceDeltaPct)}</span>
                <span className={`regime tone-${reg.tone}`}>{reg.label}</span>
              </div>
              <div className="r2">
                <span className="cell" title="aggregate open interest">
                  OI {fmtUsd(d.oiUsd)}
                  <em className={`tone-${tone(d.oiDeltaPct)}`}>{fmtPct(d.oiDeltaPct)}</em>
                </span>
                <span
                  className={`cell fund ${d.fundingHl != null && d.fundingHl > 0 ? "tone-warn" : "tone-up"}`}
                  title={fundAnnual != null ? `funding ~${fundAnnual.toFixed(0)}% APR (HL, hourly)` : "no HL funding"}
                >
                  f {d.fundingHl != null ? `${(d.fundingHl * 100).toFixed(3)}%` : "—"}
                </span>
                {liqTotal > 0 && (
                  <span
                    className={`cell liq tone-${liqNet > 0 ? "down" : "up"}`}
                    title={`liq 1h — long ${fmtUsd(d.liqLongUsd)} / short ${fmtUsd(d.liqShortUsd)}`}
                  >
                    ⚡{fmtUsd(liqTotal)}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <style jsx>{`
        .radar { display: flex; flex-direction: column; height: 100%;
          border: .5px solid var(--border); border-radius: var(--radius);
          background: var(--bg-card); overflow: hidden;
          font-family: var(--font-geist-mono), monospace; }
        .radar-bar { display: flex; align-items: baseline; gap: 8px;
          padding: 8px 12px; border-bottom: .5px solid var(--border-soft); flex: 0 0 auto; }
        .radar-title { font-size: 11px; font-weight: 600; letter-spacing: .14em; color: var(--text-strong); }
        .radar-sub { font-size: 8px; letter-spacing: .1em; color: var(--text-mute); }
        .seg { display: flex; gap: 2px; margin-left: auto; }
        .seg > button { font-size: 9px; letter-spacing: .06em; padding: 2px 6px;
          background: var(--bg-chip); border: .5px solid var(--border); border-radius: var(--radius);
          color: var(--text-mute); cursor: pointer; font-family: inherit; }
        .seg > button:hover { color: var(--text); }
        .seg > button.on { color: var(--acc-warn);
          border-color: color-mix(in oklab, var(--acc-warn) 40%, transparent); background: var(--bg-elev); }
        .radar-body { overflow-y: auto; flex: 1 1 auto; }
        .radar-empty { padding: 16px; text-align: center; color: var(--text-mute); font-size: 11px; line-height: 1.5; }
        .row { display: flex; flex-direction: column; gap: 2px; width: 100%;
          padding: 6px 12px; background: transparent; border: none; cursor: pointer;
          border-bottom: .5px solid var(--border-soft); font-family: inherit; text-align: left; }
        .row:hover { background: var(--bg-row-h); }
        .row.sel { background: color-mix(in oklab, var(--acc-warn) 8%, transparent); }
        .r1 { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
        .sym { color: var(--text); letter-spacing: .03em; min-width: 48px; }
        .row.sel .sym { color: var(--acc-warn); }
        .px { font-variant-numeric: tabular-nums; font-size: 11px; }
        .regime { margin-left: auto; font-size: 9px; letter-spacing: .08em; font-weight: 600; }
        .r2 { display: flex; gap: 10px; font-size: 10px; color: var(--text-mute); flex-wrap: wrap; }
        .cell { display: inline-flex; gap: 4px; align-items: baseline; }
        .cell em { font-style: normal; font-variant-numeric: tabular-nums; }
        .fund { letter-spacing: .02em; }
        .tone-up { color: var(--acc-up); }
        .tone-down { color: var(--acc-down); }
        .tone-warn { color: var(--acc-warn); }
        .tone-flat { color: var(--text-mute); }
      `}</style>
    </div>
  );
}

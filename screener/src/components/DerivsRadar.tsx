"use client";

// Derivs Radar v2 — HL-native positioning per coin (top-30 by volume).
// Per row: live ticking price (SSE), OI×Price regime badge, ΔOI vs 15m,
// funding APR, and a dual sparkline (price line + OI area) so OI/price
// divergence — the squeeze tell — is visible without reading a number.
// Data: /api/derivs (computed from our own price_snapshots history).

import { useEffect, useMemo, useState } from "react";
import type { HlDerivsItem } from "@/app/api/derivs/route";
import { useLiveMids } from "@/lib/useLiveMids";

const POLL_MS = 20_000;

const REGIME: Record<string, { label: string; tone: "up" | "down" | "warn" | "flat" }> = {
  short_squeeze: { label: "SQUEEZE", tone: "warn" },
  new_longs: { label: "LONGS+", tone: "up" },
  new_shorts: { label: "SHORTS+", tone: "down" },
  long_flush: { label: "FLUSH", tone: "down" },
  flat: { label: "·", tone: "flat" },
};

function fmtUsdB(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${(n / 1e3).toFixed(0)}K`;
}
function fmtPct(n: number | null, dp = 1): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(dp)}%`;
}
function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (n >= 10) return n.toFixed(2);
  if (n >= 0.1) return n.toFixed(4);
  return n.toPrecision(3);
}
function tone(n: number | null): "up" | "down" | "flat" {
  if (n == null || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

// Dual mini-chart: OI as a dim mustard area underneath, price as a line
// tinted by the 1h direction. Both series normalized to their own min/max.
function Spark({ px, oi, w = 96, h = 24 }: { px: number[]; oi: number[]; w?: number; h?: number }) {
  const path = (vals: number[]): string => {
    if (vals.length < 2) return "";
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min || 1;
    return vals
      .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
      .join(" ");
  };
  const pxPath = path(px);
  const oiPath = path(oi);
  const up = px.length >= 2 && px[px.length - 1] >= px[0];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      {oiPath && (
        <path
          d={`${oiPath} L${w},${h} L0,${h} Z`}
          fill="color-mix(in oklab, var(--acc-warn) 14%, transparent)"
          stroke="color-mix(in oklab, var(--acc-warn) 45%, transparent)"
          strokeWidth="1"
        />
      )}
      {pxPath && (
        <path d={pxPath} fill="none" stroke={up ? "var(--acc-up)" : "var(--acc-down)"} strokeWidth="1.2" />
      )}
    </svg>
  );
}

export default function DerivsRadar({
  symbol,
  onPickSymbol,
}: {
  symbol?: string | null;
  onPickSymbol?: (s: string | null) => void;
}) {
  const [items, setItems] = useState<HlDerivsItem[]>([]);
  const [sort, setSort] = useState<"flow" | "size">("flow");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () => fetch("/api/derivs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items: HlDerivsItem[] } | null) => {
        if (!cancelled && d?.items) { setItems(d.items); setReady(true); }
      })
      .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const bases = useMemo(() => items.map((i) => i.base), [items]);
  const live = useLiveMids(bases);

  const sorted = useMemo(() => {
    const arr = [...items];
    if (sort === "flow") arr.sort((a, b) => Math.abs(b.oiDeltaPct ?? 0) - Math.abs(a.oiDeltaPct ?? 0));
    else arr.sort((a, b) => b.oiUsd - a.oiUsd);
    return arr;
  }, [items, sort]);

  const warming = ready && sorted.length > 0 && sorted.every((d) => d.oiDeltaPct == null);

  return (
    <div className="radar">
      <div className="radar-bar">
        <span className="radar-title">RADAR</span>
        <span className="radar-sub">OI×PRICE · HL</span>
        <div className="seg">
          {(["flow", "size"] as const).map((s) => (
            <button key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {warming && <div className="warmup">Δ/regime warming up — needs ~15min of snapshot history</div>}

      <div className="radar-body">
        {!ready && <div className="radar-empty">loading derivs…</div>}
        {sorted.map((d) => {
          const reg = REGIME[d.regime] ?? REGIME.flat;
          const lm = live[d.base];
          const price = lm?.mid ?? d.price;
          const aprPct = d.fundingHourly != null ? d.fundingHourly * 24 * 365 * 100 : null;
          const fundHot = aprPct != null && Math.abs(aprPct) >= 25;
          return (
            <button
              key={d.base}
              className={`row ${d.base === symbol ? "sel" : ""}`}
              onClick={() => onPickSymbol?.(d.base === symbol ? null : d.base)}
              title={`${d.base} · OI ${fmtUsdB(d.oiUsd)} · vol24h ${fmtUsdB(d.volume24h)}${aprPct != null ? ` · funding ${aprPct.toFixed(1)}% APR` : ""}`}
            >
              <div className="c-id">
                <span className="sym">{d.base}</span>
                <span className={`px tick-${lm?.dir ?? "none"}`}>{fmtPrice(price)}</span>
              </div>
              <Spark px={d.spark.px} oi={d.spark.oi} />
              <div className="c-stats">
                <span className={`d tone-${tone(d.priceDeltaPct)}`}>{fmtPct(d.priceDeltaPct)}</span>
                <span className={`d tone-${tone(d.oiDeltaPct)}`} title="OI change vs 15m">
                  OI{fmtPct(d.oiDeltaPct)}
                </span>
                <span className={`d ${fundHot ? "tone-warn" : "tone-mute"}`} title="funding, annualized">
                  {aprPct != null ? `f${aprPct >= 0 ? "+" : ""}${aprPct.toFixed(0)}%` : "f—"}
                </span>
              </div>
              <span className={`regime tone-${reg.tone}`}>{reg.label}</span>
            </button>
          );
        })}
      </div>

      <style jsx>{`
        .radar { display: flex; flex-direction: column; height: 100%; overflow: hidden;
          background: var(--bg-card);
          font-family: var(--font-geist-mono), monospace; }
        .radar-bar { display: flex; align-items: baseline; gap: 8px;
          padding: 7px 12px 6px; border-bottom: .5px solid var(--border-soft); flex: 0 0 auto; }
        .radar-title { font-size: 10px; font-weight: 600; letter-spacing: .14em; color: var(--text-strong); }
        .radar-sub { font-size: 8px; letter-spacing: .1em; color: var(--text-mute); }
        .seg { display: flex; gap: 2px; margin-left: auto; }
        .seg > button { font-size: 9px; letter-spacing: .06em; padding: 2px 6px;
          background: var(--bg-chip); border: .5px solid var(--border); border-radius: var(--radius);
          color: var(--text-mute); cursor: pointer; font-family: inherit; }
        .seg > button:hover { color: var(--text); }
        .seg > button.on { color: var(--acc-warn);
          border-color: color-mix(in oklab, var(--acc-warn) 40%, transparent); background: var(--bg-elev); }
        .warmup { padding: 4px 12px; font-size: 9px; color: var(--acc-warn); letter-spacing: .06em;
          border-bottom: .5px solid var(--border-soft); }
        .radar-body { overflow-y: auto; flex: 1 1 auto; }
        .radar-empty { padding: 16px; text-align: center; color: var(--text-mute); font-size: 11px; }
        .row { display: grid; grid-template-columns: 92px 96px 1fr 58px;
          align-items: center; gap: 10px; width: 100%;
          padding: 5px 12px; background: transparent; border: none; cursor: pointer;
          border-bottom: .5px solid var(--border-soft); font-family: inherit; text-align: left; }
        .row:hover { background: var(--bg-row-h); }
        .row.sel { background: color-mix(in oklab, var(--acc-warn) 8%, transparent); }
        .c-id { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .sym { color: var(--text); font-size: 12px; letter-spacing: .03em; }
        .row.sel .sym { color: var(--acc-warn); }
        .px { font-size: 11px; color: var(--text-mute); font-variant-numeric: tabular-nums;
          transition: color .15s, text-shadow .15s; }
        .px.tick-up { color: var(--acc-up); text-shadow: 0 0 6px color-mix(in oklab, var(--acc-up) 40%, transparent); }
        .px.tick-down { color: var(--acc-down); text-shadow: 0 0 6px color-mix(in oklab, var(--acc-down) 40%, transparent); }
        .c-stats { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; }
        .d { font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.25; }
        .regime { font-size: 9px; letter-spacing: .1em; font-weight: 600; text-align: right; }
        .tone-up { color: var(--acc-up); }
        .tone-down { color: var(--acc-down); }
        .tone-warn { color: var(--acc-warn); }
        .tone-flat { color: var(--text-mute); }
        .tone-mute { color: var(--text-mute); }
      `}</style>
    </div>
  );
}

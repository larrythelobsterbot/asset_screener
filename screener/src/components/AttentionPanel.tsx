"use client";

// Attention Radar — top mention-ACCELERATION tokens from the Elfa
// social history, cross-referenced with HL price action. The discovery
// surface: where is crypto attention flowing before price reacts?
//
//   ACCUM  (mustard) attention accelerating, price flat → early window
//   CONF   (green)   attention + price rising together
//   HOLLOW (red)     price pumping, attention fading → suspect move
//   (none)           accelerating off-HL ticker → pure discovery
//
// Polls /api/social/momentum every 5 min (matches the route cache).
// Zero Elfa cost — the route computes from SQLite history.

import { useEffect, useState } from "react";
import Sparkline from "./Sparkline";
import type { MomentumResponse } from "@/app/api/social/momentum/route";

interface Props {
  onSelectAsset: (symbol: string) => void;
}

const KLASS_META: Record<
  string,
  { chip: string; title: string; tone: "warn" | "up" | "down" }
> = {
  quiet_accumulation: { chip: "ACCUM", title: "Attention accelerating, price flat — early window", tone: "warn" },
  confirmed_move: { chip: "CONF", title: "Attention and price rising together", tone: "up" },
  hollow_pump: { chip: "HOLLOW", title: "Price up, attention fading — suspect move", tone: "down" },
  accelerating: { chip: "ACCEL", title: "Attention accelerating", tone: "warn" },
};

function fmtCount(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default function AttentionPanel({ onSelectAsset }: Props) {
  const [data, setData] = useState<MomentumResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [hlOnly, setHlOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetch(`/api/social/momentum${hlOnly ? "?hl=1" : ""}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: MomentumResponse | null) => {
          if (!cancelled && d && Array.isArray(d.data)) setData(d);
          if (!cancelled) setLoading(false);
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    tick();
    const id = setInterval(tick, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hlOnly]);

  const rows = data?.data ?? [];
  const ageMin = data ? Math.max(0, Math.round((Date.now() - data.generated_at) / 60_000)) : null;

  return (
    <div className="ar-panel">
      <div className="ar-head">
        <div className="ar-head-l">
          <span className="ar-dot" />
          <span className="ar-title">Attention Radar</span>
          <span className="ar-count">{rows.length}</span>
          {data?.hypeConfluence.active && (
            <span
              className="ar-confluence"
              title={`HYPE mentions ${data.hypeConfluence.accel?.toFixed(1)}× baseline + $${Math.round((data.hypeConfluence.pressure1hUsd ?? 0) / 1000)}k TWAP buy pressure`}
            >
              ⚡ HYPE CONFLUENCE
            </span>
          )}
        </div>
        <div className="ar-head-r">
          {data?.stale && <span className="ar-stale" title="Newest mention snapshot is over 2h old">STALE</span>}
          {ageMin != null && !data?.stale && <span className="ar-age">{ageMin}m ago</span>}
          <button
            className={`ar-toggle ${hlOnly ? "on" : ""}`}
            onClick={() => setHlOnly((v) => !v)}
            title="Only show Hyperliquid-tradable symbols"
          >
            HL only
          </button>
        </div>
      </div>

      {loading ? (
        <div className="ar-empty">Reading attention history…</div>
      ) : rows.length === 0 ? (
        <div className="ar-empty">
          Building mention history — the acceleration baseline needs ~12h of
          hourly snapshots. Check back later.
        </div>
      ) : (
        <div className="ar-rows">
          {rows.map((r, i) => {
            const meta = r.klass ? KLASS_META[r.klass] : null;
            const priceTone =
              r.price24hPct == null ? "flat" : r.price24hPct > 0 ? "up" : r.price24hPct < 0 ? "down" : "flat";
            return (
              <div
                key={r.symbol}
                className={`ar-row ${r.isHL ? "clickable" : ""}`}
                onClick={r.isHL ? () => onSelectAsset(r.symbol) : undefined}
                title={meta?.title ?? (r.isHL ? "" : "Not listed on Hyperliquid")}
              >
                <span className="ar-rank">{i + 1}</span>
                <span className="ar-sym">
                  {r.symbol}
                  {!r.isHL && <span className="ar-offhl" title="Not on Hyperliquid — discovery only">·off-HL</span>}
                </span>
                <span className={`ar-spark tone-${r.accel >= 1 ? "up" : "down"}`}>
                  <Sparkline data={r.series} width={56} height={16} />
                </span>
                <span className="ar-mentions" title={`${r.mentions} mentions (24h) vs ~${r.baseline} baseline`}>
                  {fmtCount(r.mentions)}
                </span>
                <span className={`ar-accel ${r.accel >= 2 ? "hot" : r.accel <= 0.7 ? "cold" : ""}`}>
                  {r.accel.toFixed(1)}×
                </span>
                <span className={`ar-px tone-${priceTone}`}>
                  {r.price24hPct == null ? "—" : `${r.price24hPct >= 0 ? "+" : ""}${r.price24hPct.toFixed(1)}%`}
                </span>
                <span className="ar-badge-slot">
                  {meta && <span className={`ar-badge tone-bg-${meta.tone}`}>{meta.chip}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <style jsx>{`
        .ar-panel {
          background: var(--bg-card);
          border: 0.5px solid var(--border);
          border-radius: var(--radius);
          font-family: var(--font-geist-mono), ui-monospace, monospace;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .ar-head {
          display: flex; justify-content: space-between; align-items: center;
          padding: 10px 14px;
          border-bottom: 0.5px solid var(--border-soft);
        }
        .ar-head-l { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .ar-head-r { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
        .ar-dot {
          width: 6px; height: 6px; border-radius: 50%;
          background: var(--acc-warn);
          box-shadow: 0 0 0 2px color-mix(in oklab, var(--acc-warn) 25%, transparent);
        }
        .ar-title {
          font-size: 11px; font-weight: 600;
          letter-spacing: 0.12em; text-transform: uppercase;
          color: var(--text);
        }
        .ar-count {
          font-size: 10px; color: var(--text-mute);
          background: var(--bg-chip);
          padding: 1px 6px; border-radius: 3px;
        }
        .ar-confluence {
          font-size: 9px; font-weight: 600; letter-spacing: 0.08em;
          color: var(--acc-warn);
          background: color-mix(in oklab, var(--acc-warn) 14%, transparent);
          border: 0.5px solid color-mix(in oklab, var(--acc-warn) 40%, transparent);
          padding: 1px 6px; border-radius: 3px;
          white-space: nowrap;
        }
        .ar-stale {
          font-size: 9px; letter-spacing: 0.1em;
          color: var(--acc-down);
          border: 0.5px solid color-mix(in oklab, var(--acc-down) 40%, transparent);
          padding: 1px 5px; border-radius: 3px;
        }
        .ar-age { font-size: 9px; color: var(--text-mute); }
        .ar-toggle {
          font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--text-mute);
          background: var(--bg-chip);
          border: 0.5px solid transparent;
          padding: 2px 7px; border-radius: 3px;
          cursor: pointer;
          font-family: inherit;
        }
        .ar-toggle.on {
          color: var(--acc-warn);
          border-color: color-mix(in oklab, var(--acc-warn) 40%, transparent);
          background: color-mix(in oklab, var(--acc-warn) 9%, transparent);
        }
        .ar-empty {
          padding: 24px 16px;
          text-align: center;
          font-size: 11px;
          color: var(--text-mute);
          line-height: 1.6;
        }
        .ar-rows {
          overflow-y: auto;
          max-height: 420px;
        }
        .ar-row {
          display: grid;
          grid-template-columns: 20px minmax(64px, 1fr) 60px 44px 42px 52px 58px;
          align-items: center;
          gap: 6px;
          padding: 5px 14px;
          font-size: 11px;
          border-bottom: 0.5px solid var(--border-soft);
        }
        .ar-row:last-child { border-bottom: 0; }
        .ar-row.clickable { cursor: pointer; }
        .ar-row.clickable:hover { background: var(--bg-row-h); }
        .ar-rank { color: var(--text-mute); font-size: 9px; }
        .ar-sym {
          font-weight: 600; color: var(--text);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .ar-offhl {
          font-weight: 400; font-size: 9px;
          color: var(--text-mute);
          margin-left: 3px;
        }
        .ar-spark { display: flex; align-items: center; }
        .ar-mentions {
          color: var(--text-mute);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .ar-accel {
          text-align: right;
          font-variant-numeric: tabular-nums;
          color: var(--text);
        }
        .ar-accel.hot { color: var(--acc-warn); font-weight: 600; }
        .ar-accel.cold { color: var(--acc-down); }
        .ar-px {
          text-align: right;
          font-variant-numeric: tabular-nums;
          font-size: 10px;
        }
        .ar-badge-slot { display: flex; justify-content: flex-end; }
        .ar-badge {
          font-size: 8px; font-weight: 700; letter-spacing: 0.08em;
          padding: 1px 5px; border-radius: 3px;
          white-space: nowrap;
        }
        .tone-bg-warn {
          color: var(--acc-warn);
          background: color-mix(in oklab, var(--acc-warn) 14%, transparent);
        }
        .tone-bg-up {
          color: var(--acc-up);
          background: color-mix(in oklab, var(--acc-up) 14%, transparent);
        }
        .tone-bg-down {
          color: var(--acc-down);
          background: color-mix(in oklab, var(--acc-down) 14%, transparent);
        }
      `}</style>
    </div>
  );
}

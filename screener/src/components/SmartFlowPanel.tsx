"use client";

// SMART FLOW panel — /terminal. Surfaces the sharp/whale cohort's per-coin
// net positioning from /api/smart-flow (task 4): net long/short USD, its
// 1h/24h delta, and a divergence marker when the cohort is moving opposite
// the crowd's total OI. Mirrors DerivsRadar's visual language (bracket
// header, tone-* classes, dim warm-up state) so the rail reads as one
// system. netDelta1h/24h are null while the wallet poller's history is
// still warming (< ~1h / ~24h of snapshots) — rendered as an em-dash, never
// a false zero.

import { useEffect, useMemo, useState } from "react";
import type { SmartFlowCoin } from "@/app/api/smart-flow/route";

const POLL_MS = 60_000;
const TOP_N = 14;

// TODO(format.ts): consolidate — copied from ScreenerTable (audit item)
function fmtVol(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// TODO(format.ts): consolidate — copied from ScreenerTable (audit item)
function fmtSignedVol(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1) return "$0";
  return `${n > 0 ? "+" : "−"}${fmtVol(Math.abs(n))}`;
}

function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function divergeTitle(c: SmartFlowCoin): string {
  const dir = (c.netDelta24h ?? 0) > 0 ? "added longs" : "added shorts";
  return `smart cohort net-${dir} while crowd OI moved the other way — smart Δ24h ${fmtSignedVol(c.netDelta24h)}, crowd ${fmtPct(c.crowdOiChange24hPct)}`;
}

function BiasBar({ longUsd, shortUsd }: { longUsd: number; shortUsd: number }) {
  const total = longUsd + shortUsd;
  const longPct = total > 0 ? (longUsd / total) * 100 : 50;
  return (
    <div className="bias" title={`long ${fmtVol(longUsd)} · short ${fmtVol(shortUsd)}`}>
      <span className="bias-long" style={{ width: `${longPct}%` }} />
      <span className="bias-short" style={{ width: `${100 - longPct}%` }} />
    </div>
  );
}

export default function SmartFlowPanel() {
  const [coins, setCoins] = useState<SmartFlowCoin[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = () =>
      fetch("/api/smart-flow")
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { generatedAt: number; coins: SmartFlowCoin[] } | null) => {
          if (!cancelled && d?.coins) {
            setCoins(d.coins);
            setReady(true);
          }
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

  const rows = useMemo(() => coins.slice(0, TOP_N), [coins]);
  const warming = !ready || coins.length === 0;

  return (
    <div className="sfp">
      <div className="sfp-bar">
        <span className="sfp-title">SMART FLOW</span>
        <span className="sfp-sub">PROFITABLE COHORT</span>
      </div>

      {warming && (
        <div className="warmup">warming up — cohort data accumulates every 15min</div>
      )}

      <div className="sfp-body">
        {!warming &&
          rows.map((c) => (
            <div key={c.coin} className="row" title={c.diverging ? divergeTitle(c) : undefined}>
              <span className="sym">{c.coin}</span>
              <BiasBar longUsd={c.longUsd} shortUsd={c.shortUsd} />
              <span className={`net tone-${c.netUsd > 0 ? "up" : c.netUsd < 0 ? "down" : "flat"}`}>
                {fmtSignedVol(c.netUsd)}
              </span>
              <span
                className={`d24 tone-${c.netDelta24h == null ? "mute" : c.netDelta24h > 0 ? "up" : c.netDelta24h < 0 ? "down" : "flat"}`}
                title={c.netDelta24h == null ? "warming — needs 24h of poller history" : undefined}
              >
                {fmtSignedVol(c.netDelta24h)}
              </span>
              <span className="wallets" title="tracked wallets holding this coin">
                {c.wallets}w
              </span>
              {c.diverging && <span className="flag tone-warn">⚡</span>}
            </div>
          ))}
      </div>

      <style jsx>{`
        .sfp { display: flex; flex-direction: column; height: 100%; overflow: hidden;
          background: var(--bg-card);
          font-family: var(--font-geist-mono), monospace; }
        .sfp-bar { display: flex; align-items: baseline; gap: 8px;
          padding: 7px 12px 6px; border-bottom: .5px solid var(--border-soft); flex: 0 0 auto; }
        .sfp-title { font-size: 10px; font-weight: 600; letter-spacing: .14em; color: var(--text-strong); }
        .sfp-sub { font-size: 8px; letter-spacing: .1em; color: var(--text-mute); }
        .warmup { padding: 4px 12px; font-size: 9px; color: var(--acc-warn); letter-spacing: .06em;
          border-bottom: .5px solid var(--border-soft); }
        .sfp-body { overflow-y: auto; flex: 1 1 auto; }
        .row { display: grid; grid-template-columns: 46px 60px 62px 62px 30px 14px;
          align-items: center; gap: 8px; width: 100%;
          padding: 5px 12px; border-bottom: .5px solid var(--border-soft); }
        .row:hover { background: var(--bg-row-h); }
        .sym { color: var(--text); font-size: 12px; letter-spacing: .03em; }
        .bias { display: flex; width: 60px; height: 6px; border-radius: 2px; overflow: hidden;
          background: var(--bg-chip); }
        .bias-long { background: var(--acc-up); height: 100%; }
        .bias-short { background: var(--acc-down); height: 100%; }
        .net, .d24 { font-size: 10px; font-variant-numeric: tabular-nums; text-align: right; }
        .wallets { font-size: 9px; color: var(--text-mute); text-align: right; }
        .flag { font-size: 10px; text-align: center; }
        .tone-up { color: var(--acc-up); }
        .tone-down { color: var(--acc-down); }
        .tone-flat { color: var(--text-mute); }
        .tone-mute { color: var(--text-mute); }
        .tone-warn { color: var(--acc-warn); }
      `}</style>
    </div>
  );
}

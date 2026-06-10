"use client";

// Variational funding-arb board — fed by the user's own variational-api
// service via /api/variational. The user farms Variational points, so
// "where does delta-neutral funding pay best right now" is a primary
// decision input: each row is long-one-venue/short-the-other on the same
// coin, collecting the spread while staying market-neutral (and stacking
// points on the Variational leg).

import { useEffect, useState } from "react";
import type { VariationalResponse } from "@/app/api/variational/route";

const POLL_MS = 60_000;

function fmtApr(n: number): string {
  return `${n >= 0 ? "" : "−"}${Math.abs(n).toFixed(0)}%`;
}

export default function VariationalPanel() {
  const [data, setData] = useState<VariationalResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => fetch("/api/variational")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: VariationalResponse | null) => { if (!cancelled && d) setData(d); })
      .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const opps = data?.opportunities?.slice(0, 6) ?? [];

  return (
    <div className="vp">
      <div className="vp-bar">
        <span className="vp-title">VARIATIONAL</span>
        <span className="vp-sub">FUNDING ARB</span>
        {data?.summary && (
          <span className="vp-meta">{data.summary.total_markets_tracked} mkts</span>
        )}
      </div>
      <div className="vp-body">
        {!data && <div className="vp-empty">loading…</div>}
        {data && opps.length === 0 && (
          <div className="vp-empty">no spreads above threshold — service warming up or quiet market</div>
        )}
        {opps.map((o) => (
          <div
            key={`${o.ticker}-${o.cex_exchange}`}
            className="row"
            title={`${o.direction === "long_var_short_cex" ? "LONG Variational / SHORT" : "SHORT Variational / LONG"} ${o.cex_exchange} · VAR ${o.var_rate_annual.toFixed(0)}% vs ${o.cex_exchange.toUpperCase()} ${o.cex_rate_annual.toFixed(0)}% · ~$${o.daily_pnl_10k.toFixed(0)}/day per $10k`}
          >
            <span className="sym">{o.ticker}</span>
            <span className="dir">
              {o.direction === "long_var_short_cex" ? "L·var / S·" : "S·var / L·"}{o.cex_exchange}
            </span>
            <span className="spread tone-up">{fmtApr(o.spread_annual)}</span>
            <span className="daily">${o.daily_pnl_10k.toFixed(0)}/d</span>
          </div>
        ))}
      </div>
      <style jsx>{`
        .vp { display: flex; flex-direction: column; height: 100%; overflow: hidden;
          background: var(--bg-card);
          font-family: var(--font-geist-mono), monospace; }
        .vp-bar { display: flex; align-items: baseline; gap: 8px;
          padding: 7px 12px 6px; border-bottom: .5px solid var(--border-soft); flex: 0 0 auto; }
        .vp-title { font-size: 10px; font-weight: 600; letter-spacing: .14em; color: var(--text-strong); }
        .vp-sub { font-size: 8px; letter-spacing: .1em; color: var(--text-mute); }
        .vp-meta { margin-left: auto; font-size: 8px; color: var(--text-mute); letter-spacing: .06em; }
        .vp-body { overflow-y: auto; flex: 1 1 auto; }
        .vp-empty { padding: 14px; text-align: center; color: var(--text-mute); font-size: 10px; line-height: 1.5; }
        .row { display: flex; align-items: baseline; gap: 8px;
          padding: 4px 12px; font-size: 11px;
          border-bottom: .5px solid var(--border-soft); }
        .row:hover { background: var(--bg-row-h); }
        .sym { color: var(--text); min-width: 44px; letter-spacing: .03em; }
        .dir { color: var(--text-mute); font-size: 9px; letter-spacing: .04em;
          flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .spread { font-variant-numeric: tabular-nums; font-weight: 500; }
        .daily { color: var(--text-mute); font-size: 10px; font-variant-numeric: tabular-nums; min-width: 46px; text-align: right; }
        .tone-up { color: var(--acc-up); }
      `}</style>
    </div>
  );
}

"use client";

// Thin data-trust strip pinned to the bottom of the terminal. Every panel
// upstream can silently go stale (sleeping poller, dropped WS) — this row
// makes freshness a first-class signal: green dot = live, mustard = aging,
// red = stale. Added after the feed sat dead for six days unnoticed.

import { useEffect, useState } from "react";
import type { HealthResponse } from "@/app/api/health/route";

const POLL_MS = 15_000;

type Tone = "ok" | "warn" | "bad";

function ageTone(ms: number | null, warnAt: number, badAt: number): Tone {
  if (ms == null || ms > badAt) return "bad";
  if (ms > warnAt) return "warn";
  return "ok";
}

function fmtAge(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export default function StatusBar() {
  const [h, setH] = useState<HealthResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: HealthResponse | null) => { if (!cancelled && d) setH(d); })
      .catch(() => { /* keep last known */ });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const prices: Tone = h
    ? (h.hlWs.connected && h.hlWs.msSinceLastMessage >= 0 && h.hlWs.msSinceLastMessage < 10_000 ? "ok" : "warn")
    : "bad";
  const snaps = h ? ageTone(h.snapshotAgeMs, 3 * 60_000, 10 * 60_000) : "bad";
  // Tree's free tier delays items, so "fresh" here is generous by design.
  const feed = h ? ageTone(h.feedAgeMs, 30 * 60_000, 3 * 3600_000) : "bad";
  const tree: Tone = h ? (h.treeWs.connected && h.treeWs.authed ? "ok" : "warn") : "bad";

  const cell = (label: string, tone: Tone, detail: string) => (
    <span className={`cell t-${tone}`} title={detail}>
      <i className="dot" />{label}
    </span>
  );

  return (
    <div className="status">
      {cell("PRICES", prices, h ? `HL WS · ${h.hlWs.symbolCount} symbols · last msg ${fmtAge(h.hlWs.msSinceLastMessage)} ago` : "connecting…")}
      {cell(`SNAPSHOTS ${h ? fmtAge(h.snapshotAgeMs) : "—"}`, snaps, "OI/funding time-series age (drives the radar)")}
      {cell(`FEED ${h ? fmtAge(h.feedAgeMs) : "—"}`, feed, "newest Tree News item age")}
      {cell(h?.treeWs.isSub === false ? "TREE·DELAYED" : "TREE", tree, h?.treeWs.authed ? "Tree socket authed (free tier = delayed items)" : "Tree socket down — REST backfill only")}
      <span className="spacer" />
      <span className="brand">ASSET·TERMINAL</span>
      <style jsx>{`
        .status {
          display: flex; align-items: center; gap: 18px;
          padding: 5px 14px;
          font-family: var(--font-geist-mono), monospace;
          font-size: 9px; letter-spacing: .12em;
          color: var(--text-mute);
          border-top: .5px solid var(--border);
          background: var(--bg-elev);
        }
        .cell { display: inline-flex; align-items: center; gap: 6px; }
        .dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
        .t-ok .dot   { background: var(--acc-up);   box-shadow: 0 0 4px color-mix(in oklab, var(--acc-up) 60%, transparent); }
        .t-warn .dot { background: var(--acc-warn); box-shadow: 0 0 4px color-mix(in oklab, var(--acc-warn) 60%, transparent); }
        .t-bad .dot  { background: var(--acc-down); box-shadow: 0 0 4px color-mix(in oklab, var(--acc-down) 60%, transparent); }
        .t-ok { color: var(--text-mute); }
        .t-warn { color: var(--acc-warn); }
        .t-bad { color: var(--acc-down); }
        .spacer { flex: 1; }
        .brand { color: var(--text-mute); opacity: .5; letter-spacing: .25em; }
      `}</style>
    </div>
  );
}

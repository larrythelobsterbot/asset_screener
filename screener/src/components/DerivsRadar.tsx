"use client";

// Derivs Radar v2 — HL-native positioning per coin (top-30 by volume).
// Per row: live ticking price (SSE), contract-OI observational quadrant,
// contract delta vs 15m, funding APR, and a dual sparkline (price line +
// contract OI area) so the two measurements stay visibly separate.
// Data: /api/derivs (computed from our own price_snapshots history).

import { useEffect, useMemo, useState } from "react";
import type { HlDerivsItem, HlDerivsResponse } from "@/app/api/derivs/route";
import { createLatestRequestGate, parseDerivsPayload } from "@/lib/marketPolling";
import {
  latestOiSurgeEventsBySymbol,
  type OiSurgePublicEvent,
  type OiSurgePublicPayload,
} from "@/lib/oiSurge";
import { useLiveMids } from "@/lib/useLiveMids";

const POLL_MS = 20_000;

function quadrantLabel(item: HlDerivsItem): string {
  if (item.observationStatus === "stale") return "STALE";
  if (item.observationStatus !== "observed") return "NO HIST";
  const [, price, , contracts] = item.quadrant.split("_");
  return `P${price?.[0]?.toUpperCase() ?? "?"} C${contracts?.[0]?.toUpperCase() ?? "?"}`;
}

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

function surgeRank(event: OiSurgePublicEvent | undefined): number {
  if (!event) return 0;
  return event.severity === "extreme" ? 2 : 1;
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
  const [feedMetadata, setFeedMetadata] = useState<HlDerivsResponse["metadata"] | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [surgePayload, setSurgePayload] = useState<OiSurgePublicPayload | null>(null);
  const [sort, setSort] = useState<"surge" | "flow" | "size">("surge");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const gate = createLatestRequestGate();
    const tick = () => {
      const requestId = gate.start();
      fetch("/api/derivs")
        .then(async (r) => {
          const body: unknown = await r.json();
          if (!r.ok) throw new Error(`derivs HTTP ${r.status}`);
          const parsed = parseDerivsPayload(body);
          if (!parsed) throw new Error("invalid derivs payload");
          return parsed;
        })
        .then((d) => {
          if (!cancelled && gate.isCurrent(requestId)) {
            setItems(d.items);
            setFeedMetadata(d.metadata);
            setFeedError(d.metadata.error ?? null);
            setReady(true);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled && gate.isCurrent(requestId)) setFeedError(String(error));
        });
      fetch("/api/oi-surges?hours=24&limit=100")
        .then((r) => (r.ok ? r.json() : null))
        .then((payload: OiSurgePublicPayload | null) => {
          if (!cancelled && payload?.mode === "shadow" && Array.isArray(payload.events)) {
            setSurgePayload(payload);
          }
        })
        .catch(() => { /* keep last known */ });
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    const clockId = setInterval(() => setClock(Date.now()), 5_000);
    return () => { cancelled = true; gate.close(); clearInterval(id); clearInterval(clockId); };
  }, []);

  const bases = useMemo(() => items.map((i) => i.base), [items]);
  const live = useLiveMids(bases);
  const surgeBySymbol = useMemo(
    () => latestOiSurgeEventsBySymbol(surgePayload?.events ?? []),
    [surgePayload],
  );

  const sorted = useMemo(() => {
    const arr = [...items];
    if (sort === "surge") {
      arr.sort((a, b) => {
        const aSurge = surgeBySymbol.get(a.base);
        const bSurge = surgeBySymbol.get(b.base);
        return surgeRank(bSurge) - surgeRank(aSurge)
          || (bSurge?.lastDetectedAt ?? 0) - (aSurge?.lastDetectedAt ?? 0)
          || Math.abs(b.oiCoinsChangePct ?? 0) - Math.abs(a.oiCoinsChangePct ?? 0);
      });
    } else if (sort === "flow") {
      arr.sort((a, b) => Math.abs(b.oiCoinsChangePct ?? 0) - Math.abs(a.oiCoinsChangePct ?? 0));
    } else arr.sort((a, b) => b.oiUsd - a.oiUsd);
    return arr;
  }, [items, sort, surgeBySymbol]);

  const warming = ready && sorted.length > 0 && sorted.every((d) => d.oiCoinsChangePct == null);
  const feedAgeMs = feedMetadata == null ? null : Math.max(feedMetadata.ageMs, clock - feedMetadata.generatedAt);
  const feedPartial = feedMetadata?.partial === true;
  const feedStale = feedMetadata?.stale === true || feedPartial || (feedAgeMs != null && feedAgeMs > 10 * 60_000);

  return (
    <div className="radar">
      <div className="radar-bar">
        <span className="radar-title">RADAR</span>
        <span className="radar-sub">CONTRACT OI · 15M · HL</span>
        <div className="seg">
          {(["surge", "flow", "size"] as const).map((s) => (
            <button key={s} className={sort === s ? "on" : ""} onClick={() => setSort(s)}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {(feedStale || feedError) && (
        <div className="feed-status">
          {feedError
            ? `RADAR ERROR · showing last successful payload · ${feedError}`
            : feedPartial
              ? `RADAR PARTIAL · failed/stale sources: ${[...(feedMetadata?.failedSources ?? []), ...(feedMetadata?.staleSources ?? [])].join(", ") || "source timestamp unavailable"}`
              : `RADAR STALE · last payload ${Math.round((feedAgeMs ?? 0) / 1000)}s old`}
        </div>
      )}
      {surgePayload && (
        <div className="surge-strip">
          <span className={surgePayload.alertMode === "extreme-pilot" ? "pilot-chip" : "shadow-chip"}>
            {surgePayload.alertMode === "extreme-pilot" ? "EXTREME PILOT" : "SHADOW"}
          </span>
          <span>{surgePayload.summary.total} OI surge{surgePayload.summary.total === 1 ? "" : "s"} / 24h</span>
          {surgePayload.summary.extreme > 0 && <span className="surge-x">{surgePayload.summary.extreme} extreme</span>}
        </div>
      )}
      {warming && <div className="warmup">Price/contracts quadrant warming up — needs ~15min of paired snapshot history</div>}

      <div className="radar-body">
        {!ready && <div className="radar-empty">loading derivs…</div>}
        {sorted.map((d) => {
          const surge = surgeBySymbol.get(d.base);
          const lm = live[d.base];
          const price = lm?.mid ?? d.price;
          const aprPct = d.fundingHourly != null ? d.fundingHourly * 24 * 365 * 100 : null;
          const fundHot = aprPct != null && Math.abs(aprPct) >= 25;
          return (
            <button
              key={d.base}
              className={`row ${d.base === symbol ? "sel" : ""} ${surge ? `has-surge surge-${surge.severity}` : ""}`}
              onClick={() => onPickSymbol?.(d.base === symbol ? null : d.base)}
              title={`${d.contract.wireCoin} · contract OI ${d.oiCoins.toFixed(2)} · USD OI ${fmtUsdB(d.oiUsd)} · vol24h ${fmtUsdB(d.volume24h)}${d.observationAgeMs != null ? ` · history ${Math.round(d.observationAgeMs / 1000)}s old` : ""}${aprPct != null ? ` · funding ${aprPct.toFixed(1)}% APR` : ""}${surge ? ` · ${surge.severity} ${surge.primaryHorizon} OI surge: +${surge.maxOiCoinsChangePct.toFixed(1)}%, ${fmtUsdB(surge.maxQuantityDeltaUsd)}` : ""}`}
            >
              <div className="c-id">
                <span className="id-line">
                  <span className="sym">{d.base}</span>
                  <span className="venue">{d.contract.wireCoin}</span>
                  {surge && <span className={`surge-chip surge-chip-${surge.severity}`}>{surge.primaryHorizon} C</span>}
                </span>
                <span className={`px tick-${lm?.dir ?? "none"}`}>{fmtPrice(price)}</span>
              </div>
              <Spark px={d.spark.px} oi={d.spark.oiCoins} />
              <div className="c-stats">
                <span className={`d tone-${tone(d.priceDeltaPct)}`}>{fmtPct(d.priceDeltaPct)}</span>
                <span className={`d tone-${tone(d.oiCoinsChangePct)}`} title="contract quantity change vs 15m; not USD OI">
                  C{fmtPct(d.oiCoinsChangePct)}
                </span>
                {surge ? (
                  <span className={`d surge-delta surge-delta-${surge.severity}`} title="maximum confirmed OI expansion in this event thread">
                    S+{surge.maxOiCoinsChangePct.toFixed(1)}%
                  </span>
                ) : (
                  <span className={`d ${fundHot ? "tone-warn" : "tone-mute"}`} title="funding, annualized">
                    {aprPct != null ? `f${aprPct >= 0 ? "+" : ""}${aprPct.toFixed(0)}%` : "f—"}
                  </span>
                )}
              </div>
              {surge ? (
                <span className={`regime surge-status surge-status-${surge.severity}`}>
                  {surge.severity === "extreme" ? "EXTREME" : "SURGE"}
                </span>
              ) : <span className={`regime ${d.observationStatus === "observed" ? "tone-mute" : "tone-warn"}`}>{quadrantLabel(d)}</span>}
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
        .surge-strip { display: flex; align-items: center; gap: 7px; padding: 4px 12px;
          font-size: 9px; letter-spacing: .05em; color: var(--text-mute);
          border-bottom: .5px solid var(--border-soft); background: color-mix(in oklab, var(--acc-warn) 4%, transparent); }
        .shadow-chip { color: var(--acc-warn); border: .5px solid color-mix(in oklab, var(--acc-warn) 45%, transparent);
          border-radius: 3px; padding: 1px 4px; font-weight: 600; }
        .pilot-chip { color: var(--acc-down); border: .5px solid color-mix(in oklab, var(--acc-down) 55%, transparent);
          border-radius: 3px; padding: 1px 4px; font-weight: 700; }
        .surge-x { color: var(--acc-down); margin-left: auto; }
        .radar-body { overflow-y: auto; flex: 1 1 auto; }
        .radar-empty { padding: 16px; text-align: center; color: var(--text-mute); font-size: 11px; }
        .row { display: grid; grid-template-columns: 92px 96px 1fr 58px;
          align-items: center; gap: 10px; width: 100%;
          padding: 5px 12px; background: transparent; border: none; cursor: pointer;
          border-bottom: .5px solid var(--border-soft); font-family: inherit; text-align: left; }
        .row:hover { background: var(--bg-row-h); }
        .row.sel { background: color-mix(in oklab, var(--acc-warn) 8%, transparent); }
        .row.has-surge { box-shadow: inset 2px 0 0 color-mix(in oklab, var(--acc-warn) 72%, transparent); }
        .row.surge-extreme { background: color-mix(in oklab, var(--acc-down) 5%, transparent); }
        .c-id { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .id-line { display: flex; align-items: center; gap: 5px; min-width: 0; }
        .sym { color: var(--text); font-size: 12px; letter-spacing: .03em; }
        .surge-chip { font-size: 8px; line-height: 1.35; padding: 0 3px; border-radius: 2px;
          color: var(--acc-warn); border: .5px solid color-mix(in oklab, var(--acc-warn) 50%, transparent); }
        .surge-chip-extreme { color: var(--acc-down); border-color: color-mix(in oklab, var(--acc-down) 58%, transparent); }
        .row.sel .sym { color: var(--acc-warn); }
        .px { font-size: 11px; color: var(--text-mute); font-variant-numeric: tabular-nums;
          transition: color .15s, text-shadow .15s; }
        .px.tick-up { color: var(--acc-up); text-shadow: 0 0 6px color-mix(in oklab, var(--acc-up) 40%, transparent); }
        .px.tick-down { color: var(--acc-down); text-shadow: 0 0 6px color-mix(in oklab, var(--acc-down) 40%, transparent); }
        .c-stats { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; }
        .d { font-size: 10px; font-variant-numeric: tabular-nums; line-height: 1.25; }
        .regime { font-size: 9px; letter-spacing: .1em; font-weight: 600; text-align: right; }
        .surge-delta-high, .surge-status-high { color: var(--acc-warn); }
        .surge-delta-extreme, .surge-status-extreme { color: var(--acc-down); }
        .tone-up { color: var(--acc-up); }
        .tone-down { color: var(--acc-down); }
        .tone-warn { color: var(--acc-warn); }
        .tone-flat { color: var(--text-mute); }
        .tone-mute { color: var(--text-mute); }
      `}</style>
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createLatestRequestGate } from "@/lib/marketPolling";
import {
  createVisitBaseline,
  diffSinceVisit,
  getBrowserStorage,
  readVisitBaseline,
  visitIdentity,
  writeVisitBaseline,
  type VisitBaseline,
  type VisitEntry,
} from "@/lib/rotationVisit";
import {
  compareRotationRows,
  isRotationPayload,
  ROTATION_MAX_STALE_MS,
  ROTATION_WINDOWS,
  rotationStateTransition,
  type RotationPayload,
  type RotationRow,
  type RotationSortDirection,
  type RotationSortField,
  type RotationWindow,
} from "@/lib/rotation";
import { rawPriceOf } from "@/lib/priceScale";
import type { MarketContract } from "@/lib/marketContract";

interface Props {
  allowedSymbols: Set<string> | null;
  searchQuery: string;
  watchlist: Set<string>;
  showWatchlist: boolean;
  onInspectAsset: (symbol: string, contract?: MarketContract | null) => void;
}

type SortChoice = { field: RotationSortField; window: RotationWindow; direction: RotationSortDirection };
const DEFAULT_SORT: SortChoice = { field: "quantityEffectUsd", window: "8h", direction: "desc" };

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function fmtUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : value > 0 ? "+" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function fmtAbsUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return fmtUsd(Math.abs(value)).replace(/^\+/, "");
}

function fmtPrice(value: number): string {
  return value < 1 ? value.toPrecision(4) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtAge(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${Math.floor(value / 60_000)}m`;
}

function currentOiUsd(row: RotationRow): number | null {
  if (row.current.oi == null || !Number.isFinite(row.current.oi) || row.current.oi < 0) return null;
  const value = row.current.oi * rawPriceOf(row.symbol, row.current.mark);
  return Number.isFinite(value) ? value : null;
}

function volumeSource(volume: RotationRow["windows"][RotationWindow]["volume"]): string {
  if (volume.fromTs == null || volume.toTs == null) return "source [unavailable]";
  return `source [${new Date(volume.fromTs).toISOString()}, ${new Date(volume.toTs).toISOString()})`;
}

function rowEntries(rows: RotationRow[], capturedAt: number): VisitEntry[] {
  return rows.map((row) => ({
    identity: visitIdentity(row.contract),
    symbol: row.symbol,
    kind: row.contract.kind,
    dex: row.contract.dex,
    wireCoin: row.contract.wireCoin,
    historyKey: row.contract.historyKey,
    ts: row.current.ts,
    price: row.current.mark,
    oi: row.current.oi,
  })).filter((entry) => entry.ts >= 0 && entry.ts <= capturedAt && capturedAt - entry.ts <= 2 * 60_000 && entry.price > 0);
}

function baselineUsable(payload: RotationPayload, now: number): boolean {
  if (payload.metadata.stale || payload.metadata.cacheAgeMs > ROTATION_MAX_STALE_MS
    || payload.metadata.currentSourceAgeMs > payload.metadata.currentMaxAgeMs
    || payload.metadata.partialSources.length > 0 || payload.metadata.warming
    || payload.generatedAt > now + 2 * 60_000 || payload.generatedAt < now - ROTATION_MAX_STALE_MS) return false;
  return payload.rows.every((row) => row.current.ts >= 0 && row.current.ts <= now
    && now - row.current.ts <= payload.metadata.currentMaxAgeMs);
}

function metricValue(row: RotationRow, sort: SortChoice, since: ReturnType<typeof diffSinceVisit>): number | null {
  const identity = visitIdentity(row.contract);
  if (sort.field === "sinceVisitPricePct") return since.get(identity)?.pricePct ?? null;
  if (sort.field === "sinceVisitOiPct") return since.get(identity)?.oiPct ?? null;
  const metric = row.windows[sort.window];
  return sort.field === "quantityEffectUsd" ? metric.quantityEffectUsd
    : sort.field === "oiCoinPct" ? metric.oiCoinPct
      : metric.pricePct;
}

function RotationCell({ row, window }: { row: RotationRow; window: RotationWindow }) {
  const metric = row.windows[window];
  const color = metric.pricePct == null ? "" : metric.pricePct >= 0 ? "rotation-up" : "rotation-down";
  return (
    <div className="rotation-window-cell" title={`${metric.provenance}; ${volumeSource(metric.volume)}; funding ${metric.fundingProjectionStatus}`}>
      <div className="rotation-cell-line">
        <span className={color}>{fmtPct(metric.pricePct)}</span>
        <span className="rotation-muted">P {metric.priceStatus}</span>
      </div>
      <div className="rotation-cell-line">
        <span className={metric.oiCoinPct == null ? "" : metric.oiCoinPct >= 0 ? "rotation-up" : "rotation-down"}>
          {fmtPct(metric.oiCoinPct)}
        </span>
        <span className="rotation-muted">OI%</span>
      </div>
      <div className="rotation-cell-line">
        <span className={metric.quantityEffectUsd == null ? "" : metric.quantityEffectUsd >= 0 ? "rotation-up" : "rotation-down"}>
          {fmtUsd(metric.quantityEffectUsd)}
        </span>
        <span className="rotation-muted">Q</span>
      </div>
      <div className="rotation-funding">turn {fmtAbsUsd(metric.volume.notionalUsdEstimate)}{metric.volume.status === "estimated" ? " est" : ""} · {metric.volume.coverage} · fund {fmtPct(metric.fundingProjectionPct)}</div>
    </div>
  );
}

function RotationTable({
  title,
  rows,
  since,
  onInspectAsset,
}: {
  title: string;
  rows: RotationRow[];
  since: ReturnType<typeof diffSinceVisit>;
  onInspectAsset: (symbol: string, contract?: MarketContract | null) => void;
}) {
  return (
    <section className="rotation-group">
      <div className="rotation-group-heading"><span>{title}</span><span>{rows.length} markets</span></div>
      <div className="rotation-table-scroll">
        <div className="rotation-table" role="table" aria-label={`${title} rotation`}>
          <div className="rotation-header" role="row">
            <span>Market</span>
            {ROTATION_WINDOWS.map((window) => <span key={window}>{window}</span>)}
          </div>
          {rows.map((row) => (
            <button className="rotation-row" key={visitIdentity(row.contract)} onClick={() => onInspectAsset(row.symbol, row.contract)} title={`Open ${row.contract.wireCoin}`}>
              <span className="rotation-market">
                <strong>{row.symbol}</strong>
                <small>{row.contract.wireCoin} · ${fmtPrice(row.current.mark)}</small>
                <small>OI {fmtAbsUsd(currentOiUsd(row))} · 24h vol {fmtAbsUsd(row.volume24h)}</small>
                <small className="rotation-provenance">{row.contract.kind === "native" ? "native" : `HIP-3 / ${row.contract.dex}`}</small>
                <small className="rotation-state">{(["7d", "8h", "1h"] as const).map((window) => {
                  const state = rotationStateTransition(row.windows[window]);
                  return `${window} P ${state.price} · OI ${state.oi}`;
                }).join(" | ")}</small>
                {since.get(visitIdentity(row.contract)) && (() => {
                  const visit = since.get(visitIdentity(row.contract))!;
                  return <small className="rotation-visit">since visit P {fmtPct(visit.pricePct)} · OI {fmtPct(visit.oiPct)} · {new Date(visit.baselineTs).toLocaleTimeString()} → {new Date(visit.currentTs).toLocaleTimeString()}</small>;
                })()}
              </span>
              {ROTATION_WINDOWS.map((window) => <RotationCell key={window} row={row} window={window} />)}
            </button>
          ))}
          {rows.length === 0 && <div className="rotation-empty">No markets match this group.</div>}
        </div>
      </div>
    </section>
  );
}

export default function RotationView({ allowedSymbols, searchQuery, watchlist, showWatchlist, onInspectAsset }: Props) {
  const [payload, setPayload] = useState<RotationPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortChoice>(DEFAULT_SORT);
  const [baseline, setBaseline] = useState<VisitBaseline | null>(null);
  const baselineRef = useRef<VisitBaseline | null>(null);
  const [visitStatus, setVisitStatus] = useState("first visit");
  const [clock, setClock] = useState(() => Date.now());
  const [payloadReceivedAt, setPayloadReceivedAt] = useState<number | null>(null);
  const acceptedGeneratedAtRef = useRef<number | null>(null);
  const [oiFloor, setOiFloor] = useState("0");
  const [volumeFloor, setVolumeFloor] = useState("0");

  useEffect(() => {
    const storage = getBrowserStorage();
    if (!storage) {
      setVisitStatus("prior visit unavailable");
      return;
    }
    const result = readVisitBaseline(storage, Date.now());
    baselineRef.current = result.status === "ready" ? result.baseline : null;
    setBaseline(baselineRef.current);
    setVisitStatus(result.status === "ready" ? "since last visit" : result.status === "stale" ? "prior visit expired" : result.status === "invalid" ? "prior visit unavailable" : "first visit");
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const gate = createLatestRequestGate();
    async function load() {
      const requestId = gate.start();
      try {
        const response = await fetch("/api/rotation", { cache: "no-store" });
        if (!gate.isCurrent(requestId)) return;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value: unknown = await response.json();
        if (!gate.isCurrent(requestId)) return;
        if (!isRotationPayload(value)) throw new Error("Malformed rotation response");
        const receivedAt = Date.now();
        if (value.generatedAt > receivedAt + 2 * 60_000) throw new Error("Rotation response is from the future");
        if (acceptedGeneratedAtRef.current != null && value.generatedAt < acceptedGeneratedAtRef.current) return;
        if (!gate.isCurrent(requestId)) return;
        setPayload(value);
        acceptedGeneratedAtRef.current = value.generatedAt;
        setPayloadReceivedAt(receivedAt);
        setError(null);
        // The comparison baseline remains frozen for this mounted visit. Only
        // a fresh, coherent response is persisted for a future session.
        if (baselineUsable(value, receivedAt)) {
          const storage = getBrowserStorage();
          if (storage && gate.isCurrent(requestId)) {
            const latest = createVisitBaseline(rowEntries(value.rows, receivedAt), receivedAt);
            writeVisitBaseline(storage, latest);
          }
        }
      } catch (caught) {
        if (gate.isCurrent(requestId)) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (gate.isCurrent(requestId)) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 30_000);
    return () => { gate.close(); clearInterval(interval); };
  }, []);

  const since = useMemo(() => diffSinceVisit(payload ? rowEntries(payload.rows, payload.generatedAt) : [], baseline), [payload, baseline]);
  const filteredRows = useMemo(() => {
    if (!payload) return [];
    const query = searchQuery.trim().toLowerCase();
    const minimumOi = Math.max(0, Number(oiFloor) || 0);
    const minimumVolume = Math.max(0, Number(volumeFloor) || 0);
    return payload.rows.filter((row) => {
      const oi = currentOiUsd(row);
      if (oi == null || oi < minimumOi || row.volume24h < minimumVolume) return false;
      if (allowedSymbols && !allowedSymbols.has(row.symbol)) return false;
      if (showWatchlist && !watchlist.has(row.symbol)) return false;
      return !query || row.symbol.toLowerCase().includes(query) || row.name.toLowerCase().includes(query) || row.contract.wireCoin.toLowerCase().includes(query);
    }).sort((a, b) => {
      const av = metricValue(a, sort, since);
      const bv = metricValue(b, sort, since);
      if (av == null && bv == null) return compareRotationRows(a, b, DEFAULT_SORT);
      if (av == null) return 1;
      if (bv == null) return -1;
      return (sort.direction === "asc" ? av - bv : bv - av) || a.symbol.localeCompare(b.symbol);
    });
  }, [payload, allowedSymbols, searchQuery, showWatchlist, watchlist, sort, since, oiFloor, volumeFloor]);

  function resetVisit() {
    if (!payload || !baselineUsable(payload, clock)) {
      setVisitStatus("data too stale to mark reviewed");
      return;
    }
    const capturedAt = clock;
    const latest = createVisitBaseline(rowEntries(payload.rows, capturedAt), capturedAt);
    baselineRef.current = latest;
    setBaseline(latest);
    setVisitStatus(`reviewed at ${new Date(capturedAt).toLocaleTimeString()}`);
    const storage = getBrowserStorage();
    if (storage) writeVisitBaseline(storage, latest);
  }

  const crypto = filteredRows.filter((row) => row.contract.kind === "native");
  const hip3 = filteredRows.filter((row) => row.contract.kind === "hip3");

  return (
    <div className="rotation-surface">
      <header className="rotation-titlebar">
        <div>
          <div className="rotation-eyebrow">Descriptive paired-snapshot rotation</div>
          <h2>Rotation</h2>
          <p>Contract change, price change, completed-candle turnover and constant-rate funding projections. Not a trade score.</p>
        </div>
        <div className="rotation-actions">
          <span className="rotation-visit-status">{visitStatus}</span>
          <button className="rotation-button" onClick={resetVisit}>Mark reviewed</button>
        </div>
      </header>
      <div className="rotation-controls">
        <label>Rank
          <select aria-label="Rank rotation metrics" value={`${sort.field}:${sort.window}`} onChange={(event) => {
            const [field, window] = event.target.value.split(":") as [RotationSortField, RotationWindow];
            setSort((current) => ({ ...current, field, window }));
          }}>
            {ROTATION_WINDOWS.flatMap((window) => [
              <option key={`${window}:pricePct`} value={`pricePct:${window}`}>{window} price %</option>,
              <option key={`${window}:oiCoinPct`} value={`oiCoinPct:${window}`}>{window} OI %</option>,
              <option key={`${window}:quantityEffectUsd`} value={`quantityEffectUsd:${window}`}>{window} quantity USD</option>,
            ])}
            <option value="sinceVisitPricePct:8h">since-visit price %</option>
            <option value="sinceVisitOiPct:8h">since-visit OI %</option>
          </select>
        </label>
        <label>Order
          <select aria-label="Rotation sort order" value={sort.direction} onChange={(event) => setSort((current) => ({ ...current, direction: event.target.value as RotationSortDirection }))}>
            <option value="desc">decreasing</option>
            <option value="asc">increasing</option>
          </select>
        </label>
        <label>OI USD floor
          <input aria-label="OI USD floor" inputMode="decimal" value={oiFloor} onChange={(event) => setOiFloor(event.target.value)} />
        </label>
        <label>24h vol floor
          <input aria-label="24h volume floor" inputMode="decimal" value={volumeFloor} onChange={(event) => setVolumeFloor(event.target.value)} />
        </label>
        <span>Each cell: P% · contract OI% · Q USD · estimated turnover/coverage</span>
        {payload && (() => {
          const elapsed = payloadReceivedAt == null ? 0 : Math.max(0, clock - payloadReceivedAt);
          const sourceAge = payload.metadata.currentSourceAgeMs + elapsed;
          const cacheAge = payload.metadata.cacheAgeMs + elapsed;
          const warning = payload.metadata.stale || sourceAge > payload.metadata.currentMaxAgeMs || cacheAge > ROTATION_MAX_STALE_MS;
          return <span className={warning ? "rotation-warning" : ""}>
            {warning ? `stale source ${fmtAge(sourceAge)} · cache ${fmtAge(cacheAge)}` : `source age ${fmtAge(sourceAge)} · cache age ${fmtAge(cacheAge)}`}
            {payload.metadata.partialSources.length > 0 ? ` · partial ${payload.metadata.partialSources.join(",")}` : ""}
          </span>;
        })()}
      </div>
      {error && <div className="rotation-alert" role="alert">Rotation unavailable: {error}. Existing views remain available.</div>}
      {loading && !payload && <div className="rotation-empty">Warming bounded market history…</div>}
      {!loading && payload?.metadata.warming && <div className="rotation-empty">Market metadata is warming; no fabricated flat metrics are shown.</div>}
      {payload && !payload.metadata.warming && (
        <>
          <RotationTable title="Crypto / native Hyperliquid" rows={crypto} since={since} onInspectAsset={onInspectAsset} />
          <RotationTable title="HIP-3 / builder-deployed" rows={hip3} since={since} onInspectAsset={onInspectAsset} />
        </>
      )}
      <footer className="rotation-footnote">History is stored by legacy symbol, so venue-qualified identity is exact for current metadata only. Hover cells for source and coverage; unavailable means no bounded paired evidence.</footer>
      <style jsx>{`
        .rotation-surface { margin: 0 24px 18px; border: .5px solid var(--border-soft); background: var(--bg-card); }
        .rotation-titlebar { display: flex; justify-content: space-between; gap: 18px; padding: 22px 24px 18px; border-bottom: .5px solid var(--border-soft); }
        .rotation-eyebrow { color: var(--acc-warn); font: 600 9px/1 var(--font-geist-mono), monospace; letter-spacing: .16em; text-transform: uppercase; }
        .rotation-titlebar h2 { margin: 7px 0 4px; color: var(--text-strong); font-size: 22px; }
        .rotation-titlebar p { margin: 0; color: var(--text-mute); font-size: 11px; }
        .rotation-actions { display: flex; align-items: start; gap: 8px; }
        .rotation-visit-status { padding: 6px 0; color: var(--text-mute); font: 9px var(--font-geist-mono), monospace; white-space: nowrap; }
        .rotation-button { border: .5px solid var(--border-soft); border-radius: var(--radius); padding: 6px 9px; background: transparent; color: var(--text-mute); font-size: 10px; cursor: pointer; }
        .rotation-button:hover { color: var(--acc-warn); border-color: color-mix(in oklab, var(--acc-warn) 45%, transparent); }
        .rotation-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; padding: 10px 16px; border-bottom: .5px solid var(--border-soft); background: var(--bg-chip); color: var(--text-mute); font: 9px var(--font-geist-mono), monospace; }
        .rotation-controls label { display: flex; align-items: center; gap: 7px; text-transform: uppercase; letter-spacing: .08em; }
        .rotation-controls select { border: .5px solid var(--border-soft); border-radius: var(--radius); padding: 5px 7px; background: var(--bg-card); color: var(--text); font: 10px var(--font-geist-mono), monospace; }
        .rotation-controls input { width: 84px; border: .5px solid var(--border-soft); border-radius: var(--radius); padding: 5px 7px; background: var(--bg-card); color: var(--text); font: 10px var(--font-geist-mono), monospace; }
        .rotation-warning, .rotation-alert { color: var(--acc-warn); }
        .rotation-alert { padding: 10px 16px; border-bottom: .5px solid color-mix(in oklab, var(--acc-warn) 35%, transparent); background: color-mix(in oklab, var(--acc-warn) 6%, var(--bg)); font: 10px var(--font-geist-mono), monospace; }
        .rotation-group { border-bottom: .5px solid var(--border-soft); }
        .rotation-group-heading { display: flex; justify-content: space-between; padding: 10px 16px 8px; color: var(--text-mute); font: 600 9px var(--font-geist-mono), monospace; letter-spacing: .12em; text-transform: uppercase; }
        .rotation-table-scroll { overflow-x: auto; }
        .rotation-table { min-width: 880px; }
        .rotation-header, .rotation-row { display: grid; grid-template-columns: 190px repeat(5, minmax(124px, 1fr)); gap: 0; }
        .rotation-header { padding: 7px 16px; color: var(--text-faint); border-top: .5px solid var(--border-soft); border-bottom: .5px solid var(--border-soft); font: 9px var(--font-geist-mono), monospace; text-transform: uppercase; }
        .rotation-header span:not(:first-child) { text-align: right; }
        .rotation-row { width: 100%; border: 0; border-bottom: .5px solid var(--border-soft); padding: 0 16px; background: var(--bg-card); color: var(--text); text-align: left; cursor: pointer; }
        .rotation-row:hover { background: color-mix(in oklab, var(--acc-warn) 5%, var(--bg-card)); }
        .rotation-market { display: flex; flex-direction: column; justify-content: center; min-width: 0; padding: 10px 8px 10px 0; }
        .rotation-market strong { color: var(--text-strong); font: 700 12px var(--font-geist-mono), monospace; }
        .rotation-market small { overflow: hidden; color: var(--text-mute); font: 9px var(--font-geist-mono), monospace; text-overflow: ellipsis; white-space: nowrap; }
        .rotation-provenance { color: var(--text-faint) !important; }
        .rotation-state { color: var(--text-faint) !important; font-size: 8px !important; }
        .rotation-window-cell { min-width: 0; padding: 9px 4px 8px 8px; border-left: .5px solid var(--border-soft); font: 10px var(--font-geist-mono), monospace; text-align: right; }
        .rotation-cell-line { display: flex; justify-content: flex-end; align-items: baseline; gap: 5px; }
        .rotation-muted, .rotation-funding, .rotation-visit { color: var(--text-faint); font-size: 8px; }
        .rotation-funding { margin-top: 4px; }
        .rotation-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rotation-visit { margin-top: 3px; color: var(--acc-warn); }
        .rotation-up { color: var(--acc-up); } .rotation-down { color: var(--acc-down); }
        .rotation-empty { padding: 32px 18px; color: var(--text-mute); font: 10px var(--font-geist-mono), monospace; text-align: center; }
        .rotation-footnote { padding: 10px 16px 14px; color: var(--text-faint); font-size: 9px; line-height: 1.5; }
        @media (max-width: 760px) {
          .rotation-surface { margin: 0 10px 14px; }
          .rotation-titlebar { align-items: flex-start; flex-direction: column; padding: 18px 14px; }
          .rotation-actions { width: 100%; justify-content: space-between; }
          .rotation-controls { align-items: flex-start; flex-direction: column; padding: 10px 12px; }
          .rotation-group-heading { padding-left: 12px; padding-right: 12px; }
          .rotation-header, .rotation-row { padding-left: 12px; padding-right: 12px; }
        }
      `}</style>
    </div>
  );
}

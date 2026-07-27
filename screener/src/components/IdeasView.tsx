"use client";

import { useEffect, useMemo, useState } from "react";
import type { Signal } from "@/lib/signals";
import type { AssetData } from "@/lib/types";
import {
  buildMarketIdeas,
  DEFAULT_IDEA_FILTERS,
  filterMarketIdeas,
  type IdeaDirection,
  type MarketIdea,
  type MarketIdeaFilters,
} from "@/lib/marketIdeas";
import type { Timeframe } from "./TimeframeToggle";

interface Props {
  assets: AssetData[];
  signals: Signal[];
  isLoading: boolean;
  timeframe: Timeframe;
  watchlist: Set<string>;
  onToggleWatch: (symbol: string) => void;
  onInspectAsset: (symbol: string) => void;
}

function fmtUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtPrice(value: number): string {
  if (value < 0.01) return value.toPrecision(3);
  if (value < 1) return value.toPrecision(4);
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function fundingApr(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const apr = value * 24 * 365 * 100;
  return `${apr > 0 ? "+" : ""}${apr.toFixed(1)}%`;
}

function timeAgo(timestamp: number | null): string {
  if (timestamp == null) return "No active signal";
  const age = Math.max(0, Date.now() - timestamp);
  if (age < 60_000) return `${Math.floor(age / 1000)}s ago`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h ago`;
  return `${Math.floor(age / 86_400_000)}d ago`;
}

function directionLabel(direction: IdeaDirection): string {
  if (direction === "bullish") return "Bullish";
  if (direction === "bearish") return "Bearish";
  if (direction === "conflict") return "Conflict";
  return "Market watch";
}

function directionClass(direction: IdeaDirection): string {
  if (direction === "bullish") return "idea-bullish";
  if (direction === "bearish") return "idea-bearish";
  if (direction === "conflict") return "idea-conflict";
  return "idea-neutral";
}

function FilterButton<T extends string>({
  value,
  selected,
  children,
  onSelect,
}: {
  value: T;
  selected: T;
  children: React.ReactNode;
  onSelect: (value: T) => void;
}) {
  const active = value === selected;
  return (
    <button
      onClick={() => onSelect(value)}
      aria-pressed={active}
      className={active ? "idea-filter idea-filter-on" : "idea-filter"}
    >
      {children}
    </button>
  );
}

function IdeaRow({
  idea,
  rank,
  active,
  watched,
  onFocus,
  onToggleWatch,
}: {
  idea: MarketIdea;
  rank: number;
  active: boolean;
  watched: boolean;
  onFocus: () => void;
  onToggleWatch: () => void;
}) {
  const asset = idea.asset;
  return (
    <article className={active ? "idea-row idea-row-active" : "idea-row"}>
      <button className="idea-row-main" onClick={onFocus} aria-label={`Focus ${asset.symbol}`}>
        <span className="idea-rank">{rank}</span>
        <span className="idea-symbol-block">
          <strong>{asset.symbol}</strong>
          <small>{asset.name}</small>
        </span>
        <span className={`idea-direction ${directionClass(idea.direction)}`}>
          {directionLabel(idea.direction)}
        </span>
        <span className="idea-reasons">
          {idea.reasons.slice(0, 3).map((reason, index) => (
            <span key={`${reason.kind}-${reason.label}-${index}`} className={`idea-reason reason-${reason.tone}`}>
              {reason.label}
            </span>
          ))}
          {idea.reasons.length === 0 && <span className="idea-reason reason-neutral">No active anomaly</span>}
        </span>
        <span className="idea-metric">
          <small>24h</small>
          <strong className={(asset.change24h ?? 0) >= 0 ? "metric-up" : "metric-down"}>
            {fmtPct(asset.change24h)}
          </strong>
        </span>
        <span className="idea-metric hide-narrow">
          <small>OI Δ</small>
          <strong>{fmtPct(asset.oiChange24hPct)}</strong>
        </span>
        <span className="idea-metric hide-narrow">
          <small>Volume</small>
          <strong>{fmtUsd(asset.volume24h)}</strong>
        </span>
        <span className="idea-freshness">
          {idea.signalCount > 0 ? `${idea.familyCount} fam · ${timeAgo(idea.latestSignalAt)}` : `${idea.anomalyCount} reads`}
        </span>
      </button>
      <button
        className={watched ? "idea-watch idea-watch-on" : "idea-watch"}
        onClick={onToggleWatch}
        aria-label={watched ? `Remove ${asset.symbol} from watchlist` : `Add ${asset.symbol} to watchlist`}
        title={watched ? "Remove from watchlist" : "Add to watchlist"}
      >
        {watched ? "★" : "☆"}
      </button>
    </article>
  );
}

function IdeaInspector({
  idea,
  onInspectAsset,
}: {
  idea: MarketIdea | null;
  onInspectAsset: (symbol: string) => void;
}) {
  if (!idea) {
    return <aside className="idea-inspector"><div className="idea-empty">No markets match this view.</div></aside>;
  }
  const asset = idea.asset;
  return (
    <aside className="idea-inspector">
      <div className="inspector-kicker">Selected market</div>
      <div className="inspector-title-row">
        <div>
          <h2>{asset.symbol}</h2>
          <p>{asset.name} · {asset.sector}</p>
        </div>
        <span className={`idea-direction ${directionClass(idea.direction)}`}>
          {directionLabel(idea.direction)}
        </span>
      </div>
      <div className="inspector-price">${fmtPrice(asset.price)}</div>

      <div className="inspector-stats">
        <div><small>24h move</small><strong>{fmtPct(asset.change24h)}</strong></div>
        <div><small>OI USD</small><strong>{fmtUsd(asset.oiUsd)}</strong></div>
        <div><small>OI Δ24h</small><strong>{fmtPct(asset.oiChange24hPct)}</strong></div>
        <div><small>Funding APR</small><strong>{fundingApr(asset.fundingAvg24h)}</strong></div>
        <div><small>Vol / OI</small><strong>{asset.volOiRatio == null ? "—" : `${asset.volOiRatio.toFixed(1)}×`}</strong></div>
        <div><small>Signal families</small><strong>{idea.familyCount || "—"}</strong></div>
      </div>

      <section className="inspector-section">
        <div className="inspector-section-title">Why it is ranked here</div>
        {idea.reasons.length > 0 ? idea.reasons.map((reason, index) => (
          <div key={`${reason.kind}-${reason.label}-${index}`} className="inspector-reason">
            <span className={`reason-dot reason-${reason.tone}`} />
            <span>{reason.label}</span>
          </div>
        )) : <div className="idea-empty compact">No signal or anomaly evidence.</div>}
      </section>

      <section className="inspector-section external-section">
        <div className="inspector-section-title">External intelligence</div>
        <p>No external provider is connected. Paste.trade can appear here after official read-only access is available.</p>
        <a href="https://paste.trade/" target="_blank" rel="noreferrer">Open Paste.trade ↗</a>
        <small>External calls remain descriptive evidence and never affect Telegram eligibility.</small>
      </section>

      <button className="inspect-button" onClick={() => onInspectAsset(asset.symbol)}>
        Open full market detail
      </button>
    </aside>
  );
}

export default function IdeasView({
  assets,
  signals,
  isLoading,
  timeframe,
  watchlist,
  onToggleWatch,
  onInspectAsset,
}: Props) {
  const [filters, setFilters] = useState<MarketIdeaFilters>(DEFAULT_IDEA_FILTERS);
  const [focusedSymbol, setFocusedSymbol] = useState<string | null>(null);
  const [density, setDensity] = useState<"compact" | "spaced">("compact");
  const ideas = useMemo(
    () => filterMarketIdeas(buildMarketIdeas(assets, signals, timeframe), filters),
    [assets, signals, timeframe, filters],
  );
  const focused = ideas.find((idea) => idea.asset.symbol === focusedSymbol) ?? ideas[0] ?? null;

  useEffect(() => {
    if (focusedSymbol && !ideas.some((idea) => idea.asset.symbol === focusedSymbol)) {
      setFocusedSymbol(null);
    }
  }, [focusedSymbol, ideas]);

  if (isLoading) {
    return <div className="idea-loading">Building opportunity board…</div>;
  }

  return (
    <div className={`ideas-surface density-${density}`}>
      <header className="ideas-header">
        <div>
          <div className="ideas-eyebrow">Evidence-ranked discovery</div>
          <h2>Opportunity Board</h2>
          <p>Signals first, then market anomalies. No hidden composite score.</p>
        </div>
        <div className="ideas-count"><strong>{ideas.length}</strong><span>markets</span></div>
      </header>

      <div className="ideas-controls" role="group" aria-label="Idea filters">
        <div className="ideas-control-group">
          <span>Direction</span>
          {(["any", "bullish", "bearish", "conflict"] as const).map((value) => (
            <FilterButton key={value} value={value} selected={filters.direction} onSelect={(direction) => setFilters((current) => ({ ...current, direction }))}>
              {value === "any" ? "All" : directionLabel(value)}
            </FilterButton>
          ))}
        </div>
        <div className="ideas-control-group">
          <span>Evidence</span>
          {(["actionable", "signals", "anomalies", "all"] as const).map((value) => (
            <FilterButton key={value} value={value} selected={filters.evidence} onSelect={(evidence) => setFilters((current) => ({ ...current, evidence }))}>
              {value === "actionable" ? "Actionable" : value === "all" ? "All" : value === "signals" ? "Signals" : "Anomalies"}
            </FilterButton>
          ))}
        </div>
        <div className="ideas-control-group">
          <span>Freshness</span>
          {[{ label: "Any", value: "any" }, { label: "6h", value: "6" }, { label: "24h", value: "24" }].map((option) => {
            const selected = filters.maxSignalAgeHours == null ? "any" : String(filters.maxSignalAgeHours);
            return <FilterButton key={option.value} value={option.value} selected={selected} onSelect={(value) => setFilters((current) => ({ ...current, maxSignalAgeHours: value === "any" ? null : Number(value) }))}>{option.label}</FilterButton>;
          })}
        </div>
        <div className="ideas-control-group density-control">
          <span>Density</span>
          <FilterButton value="compact" selected={density} onSelect={setDensity}>Compact</FilterButton>
          <FilterButton value="spaced" selected={density} onSelect={setDensity}>Spaced</FilterButton>
        </div>
      </div>

      <div className="ideas-grid">
        <section className="idea-list" aria-label="Ranked market ideas">
          {ideas.map((idea, index) => (
            <IdeaRow
              key={idea.asset.symbol}
              idea={idea}
              rank={index + 1}
              active={focused?.asset.symbol === idea.asset.symbol}
              watched={watchlist.has(idea.asset.symbol)}
              onFocus={() => setFocusedSymbol(idea.asset.symbol)}
              onToggleWatch={() => onToggleWatch(idea.asset.symbol)}
            />
          ))}
          {ideas.length === 0 && <div className="idea-empty">No markets match the active idea filters.</div>}
        </section>
        <IdeaInspector idea={focused} onInspectAsset={onInspectAsset} />
      </div>

      <style jsx global>{`
        .ideas-surface { margin: 0 24px 18px; border: .5px solid var(--border-soft); background: var(--bg-card); min-height: 620px; }
        .ideas-header { display: flex; justify-content: space-between; gap: 20px; padding: 22px 24px 18px; border-bottom: .5px solid var(--border-soft); }
        .ideas-eyebrow, .inspector-kicker { color: var(--acc-warn); font: 600 9px/1 var(--font-geist-mono), monospace; letter-spacing: .16em; text-transform: uppercase; }
        .ideas-header h2 { margin: 7px 0 4px; font-size: 22px; color: var(--text-strong); }
        .ideas-header p { margin: 0; color: var(--text-mute); font-size: 11px; }
        .ideas-count { min-width: 74px; text-align: right; font-family: var(--font-geist-mono), monospace; }
        .ideas-count strong { display: block; color: var(--text-strong); font-size: 24px; }
        .ideas-count span { color: var(--text-mute); font-size: 9px; letter-spacing: .12em; text-transform: uppercase; }
        .ideas-controls { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: end; padding: 12px 16px; border-bottom: .5px solid var(--border-soft); background: var(--bg-chip); }
        .ideas-control-group { display: flex; align-items: center; gap: 5px; }
        .ideas-control-group > span { margin-right: 3px; color: var(--text-mute); font-size: 8px; letter-spacing: .13em; text-transform: uppercase; }
        .density-control { margin-left: auto; }
        .idea-filter { border: .5px solid var(--border-soft); background: transparent; color: var(--text-mute); padding: 5px 8px; border-radius: var(--radius); font-size: 10px; cursor: pointer; }
        .idea-filter:hover { color: var(--text); border-color: var(--border); }
        .idea-filter-on { color: var(--acc-warn); border-color: color-mix(in oklab, var(--acc-warn) 45%, transparent); background: color-mix(in oklab, var(--acc-warn) 8%, transparent); }
        .ideas-grid { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(290px, .7fr); height: clamp(500px, calc(100vh - 285px), 760px); }
        .idea-list { min-width: 0; overflow-y: auto; border-right: .5px solid var(--border-soft); scrollbar-color: var(--border) transparent; }
        .idea-row { position: relative; display: flex; border-bottom: .5px solid var(--border-soft); background: var(--bg-card); }
        .idea-row:hover, .idea-row-active { background: color-mix(in oklab, var(--acc-warn) 5%, var(--bg-card)); }
        .idea-row-active::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--acc-warn); }
        .idea-row-main { flex: 1; min-width: 0; display: grid; grid-template-columns: 28px 96px 72px minmax(180px, 1fr) 62px 62px 72px 92px; gap: 9px; align-items: center; border: 0; background: transparent; color: inherit; text-align: left; padding: 11px 12px; cursor: pointer; }
        .density-spaced .idea-row-main { padding-top: 16px; padding-bottom: 16px; }
        .idea-rank { color: var(--text-mute); font: 10px var(--font-geist-mono), monospace; text-align: center; }
        .idea-symbol-block { min-width: 0; }
        .idea-symbol-block strong { display: block; color: var(--text-strong); font: 700 13px var(--font-geist-mono), monospace; }
        .idea-symbol-block small { display: block; overflow: hidden; color: var(--text-mute); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
        .idea-direction { display: inline-flex; justify-content: center; border: .5px solid; border-radius: 999px; padding: 4px 7px; font: 600 9px var(--font-geist-mono), monospace; text-transform: uppercase; }
        .idea-bullish { color: var(--acc-up); border-color: color-mix(in oklab, var(--acc-up) 35%, transparent); background: color-mix(in oklab, var(--acc-up) 8%, transparent); }
        .idea-bearish { color: var(--acc-down); border-color: color-mix(in oklab, var(--acc-down) 35%, transparent); background: color-mix(in oklab, var(--acc-down) 8%, transparent); }
        .idea-conflict { color: var(--acc-warn); border-color: color-mix(in oklab, var(--acc-warn) 35%, transparent); background: color-mix(in oklab, var(--acc-warn) 8%, transparent); }
        .idea-neutral { color: var(--text-mute); border-color: var(--border-soft); background: var(--bg-chip); }
        .idea-reasons { min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; max-height: 38px; overflow: hidden; }
        .idea-reason { max-width: 100%; overflow: hidden; border: .5px solid var(--border-soft); border-radius: 3px; padding: 3px 5px; color: var(--text); background: var(--bg-chip); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
        .reason-bullish { color: var(--acc-up); } .reason-bearish { color: var(--acc-down); } .reason-warn { color: var(--acc-warn); } .reason-neutral { color: var(--text-mute); }
        .idea-metric { min-width: 0; text-align: right; font-family: var(--font-geist-mono), monospace; }
        .idea-metric small { display: block; color: var(--text-mute); font-size: 8px; text-transform: uppercase; }
        .idea-metric strong { display: block; margin-top: 3px; color: var(--text); font-size: 10px; }
        .idea-metric .metric-up { color: var(--acc-up); } .idea-metric .metric-down { color: var(--acc-down); }
        .idea-freshness { color: var(--text-mute); font: 9px var(--font-geist-mono), monospace; text-align: right; }
        .idea-watch { width: 34px; border: 0; border-left: .5px solid var(--border-soft); background: transparent; color: var(--text-mute); cursor: pointer; }
        .idea-watch:hover, .idea-watch-on { color: var(--acc-warn); }
        .idea-inspector { padding: 22px; background: var(--bg); min-width: 0; overflow-y: auto; scrollbar-color: var(--border) transparent; }
        .inspector-title-row { display: flex; justify-content: space-between; align-items: start; gap: 12px; margin-top: 12px; }
        .inspector-title-row h2 { margin: 0; color: var(--text-strong); font: 700 24px var(--font-geist-mono), monospace; }
        .inspector-title-row p { margin: 3px 0 0; color: var(--text-mute); font-size: 10px; text-transform: capitalize; }
        .inspector-price { margin: 16px 0; color: var(--text-strong); font: 24px var(--font-geist-mono), monospace; }
        .inspector-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--border-soft); border: .5px solid var(--border-soft); }
        .inspector-stats > div { background: var(--bg-card); padding: 10px; }
        .inspector-stats small { display: block; color: var(--text-mute); font-size: 8px; letter-spacing: .1em; text-transform: uppercase; }
        .inspector-stats strong { display: block; margin-top: 4px; color: var(--text); font: 11px var(--font-geist-mono), monospace; }
        .inspector-section { margin-top: 20px; }
        .inspector-section-title { margin-bottom: 9px; color: var(--text-mute); font-size: 9px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
        .inspector-reason { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: .5px solid var(--border-soft); color: var(--text); font-size: 10px; }
        .reason-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
        .external-section { padding: 12px; border: .5px solid var(--border-soft); background: var(--bg-card); }
        .external-section p { margin: 0 0 8px; color: var(--text-mute); font-size: 10px; line-height: 1.5; }
        .external-section a { color: var(--acc-warn); font-size: 10px; text-decoration: none; }
        .external-section small { display: block; margin-top: 8px; color: var(--text-faint); font-size: 8px; line-height: 1.45; }
        .inspect-button { width: 100%; margin-top: 18px; padding: 10px; border: .5px solid color-mix(in oklab, var(--acc-warn) 45%, transparent); background: color-mix(in oklab, var(--acc-warn) 8%, transparent); color: var(--acc-warn); border-radius: var(--radius); font-size: 10px; font-weight: 700; cursor: pointer; }
        .idea-empty, .idea-loading { padding: 48px 20px; color: var(--text-mute); font-size: 11px; text-align: center; }
        .idea-empty.compact { padding: 12px 0; text-align: left; }
        @media (max-width: 1180px) {
          .ideas-grid { grid-template-columns: 1fr; height: auto; }
          .idea-list { max-height: 62vh; border-right: 0; }
          .idea-inspector { overflow: visible; border-top: .5px solid var(--border-soft); }
          .idea-row-main { grid-template-columns: 24px 90px 68px minmax(150px, 1fr) 58px 78px; }
          .hide-narrow { display: none; }
        }
        @media (max-width: 760px) {
          .ideas-surface { margin: 0 10px 14px; }
          .ideas-header { padding: 18px 14px; }
          .ideas-controls { align-items: flex-start; }
          .ideas-control-group { flex-wrap: wrap; }
          .density-control { margin-left: 0; }
          .idea-row-main { grid-template-columns: 22px 72px 66px 1fr; padding: 11px 8px; }
          .idea-reasons { grid-column: 2 / -1; }
          .idea-metric, .idea-freshness { display: none; }
          .idea-watch { width: 30px; }
        }
      `}</style>
    </div>
  );
}

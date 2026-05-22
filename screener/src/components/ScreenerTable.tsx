"use client";

import { useEffect, useMemo, useState } from "react";
import { AssetData } from "@/lib/types";
import { SECTORS } from "@/config/sectors";
import { Timeframe as HeatmapTF } from "./TimeframeToggle";
import type { ScreenerRow } from "@/app/api/screener/route";
import Sparkline from "./Sparkline";
import RSIGauge from "./RSIGauge";
import MAGrid from "./MAGrid";

// Dense Bracket-style table view.
//
// Visual hooks (CSS in globals.css owns the heavy lifting):
//   .sym         — bracket-wraps the ticker via pseudo-elements
//   .pct-tri     — triangle ▲/▼ via pseudo-element, scoped to dir % cells
//   .tone-up/-down/-flat — text color via CSS var
//
// Row hover state (mustard ring + sym/name color shift) lives in
// globals.css too. Hover styles defined here would lose specificity to
// the `transition` line, so we keep them centralized.

type SortKey =
  | "name"
  | "price"
  | "change1h"
  | "change4h"
  | "change24h"
  | "change7d"
  | "vol_ratio"
  | "ath_pct"
  | "rsi"
  | "volume24h";

function mapToCandleTF(tf: HeatmapTF): "1h" | "4h" | "1d" {
  if (tf === "1h") return "1h";
  if (tf === "4h") return "4h";
  return "1d";
}

function fmtPrice(n: number): string {
  if (n < 0.01) return n.toPrecision(3);
  if (n < 1) return n.toPrecision(4);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n: number | null, zeroDash: boolean = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return zeroDash ? "—" : "0.00%";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function toneClass(n: number | null): string {
  if (n == null) return "tone-mute";
  if (n > 0.005) return "tone-up";
  if (n < -0.005) return "tone-down";
  return "tone-flat";
}

function fmtVol(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

interface Props {
  assets: AssetData[];
  isLoading: boolean;
  timeframe: HeatmapTF;
  onSelectAsset: (symbol: string) => void;
  showWatchlistOnly: boolean;
  watchlist: Set<string>;
  onToggleWatch: (symbol: string) => void;
  // Hide-list. When showHidden is false, page.tsx has already filtered
  // these out of `assets`. When true, hidden assets are passed through
  // and we dim them so the user can spot + unhide.
  hidden?: Set<string>;
  onToggleHide?: (symbol: string) => void;
  showHidden?: boolean;
  // Optional text filter from the top-bar search input (case-insensitive,
  // matches name OR symbol). Empty/undefined = no filter.
  searchQuery?: string;
}

export default function ScreenerTable({
  assets, isLoading, timeframe, onSelectAsset,
  showWatchlistOnly, watchlist, onToggleWatch,
  hidden, onToggleHide,
  // showHidden is consumed by page.tsx's filteredAssets memo — by the
  // time the table receives `assets` it's already had hidden items
  // included/excluded. We accept the prop for future use (and to keep
  // the API symmetric with Heatmap) but intentionally don't read it.
  searchQuery,
}: Props) {
  const candleTf = mapToCandleTF(timeframe);
  const [screenerRows, setScreenerRows] = useState<ScreenerRow[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("volume24h");
  const [sortAsc, setSortAsc] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setScreenerLoading(true);
    const fetchOnce = () => fetch(`/api/screener?tf=${candleTf}`)
      .then((r) => r.json())
      .then((data: ScreenerRow[]) => {
        if (cancelled) return;
        if (Array.isArray(data)) setScreenerRows(data);
        setScreenerLoading(false);
      })
      .catch(() => { if (!cancelled) setScreenerLoading(false); });
    fetchOnce();
    const interval = setInterval(fetchOnce, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [candleTf]);

  const screenerBySymbol = useMemo(() => {
    const m = new Map<string, ScreenerRow>();
    for (const r of screenerRows) m.set(r.symbol, r);
    return m;
  }, [screenerRows]);

  const visibleAssets = useMemo(() => {
    let arr = showWatchlistOnly ? assets.filter((a) => watchlist.has(a.symbol)) : assets;
    if (searchQuery && searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      arr = arr.filter((a) =>
        a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
      );
    }
    return arr;
  }, [assets, showWatchlistOnly, watchlist, searchQuery]);

  const sorted = useMemo(() => {
    const arr = [...visibleAssets];
    arr.sort((a, b) => {
      const sa = screenerBySymbol.get(a.symbol);
      const sb = screenerBySymbol.get(b.symbol);
      const va = ((): number | string => {
        switch (sortKey) {
          case "name": return a.name;
          case "price": return a.price;
          case "change1h": return a.change1h ?? -Infinity;
          case "change4h": return a.change4h ?? -Infinity;
          case "change24h": return a.change24h ?? -Infinity;
          case "change7d": return a.change7d ?? -Infinity;
          case "vol_ratio": return sa?.vol_ratio ?? -Infinity;
          case "ath_pct": return sa?.ath_pct ?? -Infinity;
          case "rsi": return sa?.rsi ?? -Infinity;
          case "volume24h": return a.volume24h;
        }
      })();
      const vb = ((): number | string => {
        switch (sortKey) {
          case "name": return b.name;
          case "price": return b.price;
          case "change1h": return b.change1h ?? -Infinity;
          case "change4h": return b.change4h ?? -Infinity;
          case "change24h": return b.change24h ?? -Infinity;
          case "change7d": return b.change7d ?? -Infinity;
          case "vol_ratio": return sb?.vol_ratio ?? -Infinity;
          case "ath_pct": return sb?.ath_pct ?? -Infinity;
          case "rsi": return sb?.rsi ?? -Infinity;
          case "volume24h": return b.volume24h;
        }
      })();
      const dir = sortAsc ? 1 : -1;
      if (typeof va === "string" && typeof vb === "string") {
        return va.localeCompare(vb) * dir;
      }
      return ((va as number) - (vb as number)) * dir;
    });
    return arr;
  }, [visibleAssets, screenerBySymbol, sortKey, sortAsc]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      // name is the only one we want asc by default; everything else
      // reads "biggest first" more naturally.
      setSortAsc(key === "name");
    }
  };

  const arr = (key: SortKey) =>
    sortKey === key ? (
      <span style={{ color: "var(--acc-warn)", fontSize: 8, marginLeft: 4 }}>
        {sortAsc ? "▲" : "▼"}
      </span>
    ) : null;

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-white/20 border-t-acc-warn rounded-full animate-spin" />
          <span style={{ fontSize: 11, color: "var(--text-mute)", letterSpacing: ".12em", textTransform: "uppercase" }}>
            Loading markets…
          </span>
        </div>
      </div>
    );
  }

  if (showWatchlistOnly && sorted.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="text-center">
          <span style={{ fontSize: 24, display: "block", marginBottom: 8, color: "var(--text-mute)" }}>☆</span>
          <span style={{ fontSize: 12, color: "var(--text-mute)" }}>No assets in your watchlist yet.</span>
        </div>
      </div>
    );
  }

  const thStyle: React.CSSProperties = {
    padding: "8px 10px",
    fontSize: 10, fontWeight: 500,
    letterSpacing: ".1em", textTransform: "uppercase",
    color: "var(--text-mute)",
    whiteSpace: "nowrap",
    userSelect: "none",
    cursor: "pointer",
    borderBottom: ".5px solid var(--border)",
    background: "var(--bg-card)",
    textAlign: "left",
    position: "sticky", top: 0,
  };
  const thRight: React.CSSProperties = { ...thStyle, textAlign: "right" };

  return (
    <div style={{ padding: "0 24px 24px" }}>
      <div
        className="density-comfy"
        style={{
          background: "var(--bg-card)",
          border: ".5px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        {/* Header band */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 14px",
          borderBottom: ".5px solid var(--border)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="pulse" />
            <span style={{
              fontSize: 11, fontWeight: 600,
              letterSpacing: ".16em", textTransform: "uppercase",
              color: "var(--text)",
            }}>
              Screener
            </span>
            <span style={{
              fontSize: 10, color: "var(--text-mute)",
              padding: "2px 6px", borderRadius: 3,
              background: "var(--bg-chip)",
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            }}>
              {sorted.length} / {assets.length}
            </span>
            <span style={{
              fontSize: 10, color: "var(--text-mute)",
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            }}>
              MAs: {candleTf}
            </span>
          </div>
          {screenerLoading && (
            <span style={{ fontSize: 10, color: "var(--text-mute)" }}>computing indicators…</span>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ ...thRight, width: 32 }}>#</th>
                <th style={thStyle} onClick={() => handleSort("name")}>Name{arr("name")}</th>
                <th style={thStyle}>Sym</th>
                <th style={thRight} onClick={() => handleSort("price")}>Price{arr("price")}</th>
                <th style={thRight} onClick={() => handleSort("change1h")}>1H%{arr("change1h")}</th>
                <th style={thRight} onClick={() => handleSort("change4h")}>4H%{arr("change4h")}</th>
                <th style={thRight} onClick={() => handleSort("change24h")}>24H%{arr("change24h")}</th>
                <th style={thRight} onClick={() => handleSort("change7d")}>7D%{arr("change7d")}</th>
                <th style={thRight} onClick={() => handleSort("volume24h")}>Vol 24H{arr("volume24h")}</th>
                <th style={thRight} onClick={() => handleSort("vol_ratio")}>Vol Ratio{arr("vol_ratio")}</th>
                <th style={thRight} onClick={() => handleSort("ath_pct")}>ATH%{arr("ath_pct")}</th>
                <th style={{ ...thStyle, width: 100, textAlign: "center" }}>Spark</th>
                <th style={thStyle} onClick={() => handleSort("rsi")}>RSI{arr("rsi")}</th>
                <th style={thStyle}>MAs ({candleTf})</th>
                <th style={{ ...thStyle, width: 56 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a, i) => {
                const sr = screenerBySymbol.get(a.symbol) ?? null;
                const sectorColor = SECTORS[a.sector]?.color ?? "#64748B";
                const isWatched = watchlist.has(a.symbol);
                const isHidden = hidden?.has(a.symbol) ?? false;
                const sparkTone = sr && sr.sparkline.length > 1
                  ? (sr.sparkline[sr.sparkline.length - 1] >= sr.sparkline[0] ? "tone-up" : "tone-down")
                  : "tone-mute";
                return (
                  <tr
                    key={a.symbol}
                    className={`screener-row${isHidden ? " row-hidden" : ""}`}
                    onClick={() => onSelectAsset(a.symbol)}
                  >
                    <td className="cell-rank">{String(i + 1).padStart(2, "0")}</td>
                    <td className="cell-name">
                      <span className="sec-dot" style={{ background: sectorColor, marginRight: 8 }} />
                      <span className="name-txt">{a.name}</span>
                    </td>
                    <td className="cell-sym"><span className="sym">{a.symbol}</span></td>
                    <td className="cell-num cell-price">${fmtPrice(a.price)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change1h)}`}>{fmtPct(a.change1h, true)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change4h)}`}>{fmtPct(a.change4h, true)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change24h)}`}>{fmtPct(a.change24h)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change7d)}`}>{fmtPct(a.change7d)}</td>
                    <td className="cell-num cell-vol">{fmtVol(a.volume24h)}</td>
                    <td className="cell-num">
                      {sr?.vol_ratio != null ? (
                        <span className={sr.vol_ratio >= 2 ? "vol-ratio-hot" : "vol-ratio"}>
                          {sr.vol_ratio.toFixed(2)}×
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-mute)" }}>—</span>
                      )}
                    </td>
                    <td className={`cell-num ${
                      sr?.ath_pct == null ? "tone-mute" :
                      sr.ath_pct <= -50 ? "tone-down" :
                      sr.ath_pct <= -20 ? "tone-warn" :
                      "tone-mute"
                    }`}>
                      {sr?.ath_pct == null ? "—" : `${sr.ath_pct.toFixed(1)}%`}
                    </td>
                    <td className={`cell-spark ${sparkTone}`}>
                      <Sparkline data={sr?.sparkline ?? []} width={80} height={24} />
                    </td>
                    <td className="cell-rsi">
                      <RSIGauge value={sr?.rsi ?? null} />
                    </td>
                    <td className="cell-mas">
                      <MAGrid row={sr} />
                    </td>
                    <td className="cell-actions">
                      <div className="row-actions">
                        <button
                          onClick={(e) => { e.stopPropagation(); onToggleWatch(a.symbol); }}
                          className={isWatched ? "row-btn star star-on" : "row-btn star"}
                          title={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                        >
                          {isWatched ? "★" : "☆"}
                        </button>
                        {onToggleHide && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onToggleHide(a.symbol); }}
                            className={isHidden ? "row-btn hide-btn hide-on" : "row-btn hide-btn"}
                            title={isHidden ? "Unhide this asset" : "Hide this asset (remove from screener)"}
                          >
                            {isHidden ? "↻" : "✕"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Row-level styling is in this scoped style block so the mustard
          hover ring + sym/name color shift land precisely. Doing it via
          inline style would lose the :hover-on-tr targeting; doing it in
          globals.css would scatter the table-only rules across the file. */}
      <style jsx>{`
        :global(.screener-row) {
          cursor: pointer;
          transition: background .12s, box-shadow .12s;
        }
        :global(.screener-row:hover) {
          background: var(--bg-row-h);
          box-shadow: inset 0 0 0 .5px color-mix(in oklab, var(--acc-warn) 55%, transparent);
        }
        :global(.screener-row:hover .sym),
        :global(.screener-row:hover .name-txt) {
          color: var(--acc-warn);
        }
        :global(.screener-row:hover .sym::before),
        :global(.screener-row:hover .sym::after) {
          color: var(--acc-warn);
        }
        :global(.screener-row + .screener-row td) {
          border-top: .5px solid var(--border-soft);
        }
        :global(.screener-row td) {
          padding: var(--row-pad, 7px) 10px;
          white-space: nowrap;
          vertical-align: middle;
        }
        :global(.cell-rank) {
          text-align: right;
          color: var(--text-mute);
          font-size: 10px;
          width: 32px;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.cell-name) {
          padding-left: 14px !important;
          color: var(--text);
        }
        :global(.cell-name .name-txt) {
          font-size: 12px;
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          display: inline-block;
          vertical-align: middle;
          transition: color .12s;
        }
        :global(.cell-sym) {
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.cell-num) {
          text-align: right;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
          font-size: 12px;
        }
        :global(.cell-price) {
          color: var(--text-strong);
        }
        :global(.cell-vol) {
          color: var(--text-mute);
        }
        :global(.cell-spark) {
          width: 100px;
          text-align: center;
        }
        :global(.vol-ratio) {
          color: var(--text-mute);
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.vol-ratio-hot) {
          color: var(--acc-warn);
          background: color-mix(in oklab, var(--acc-warn) 14%, transparent);
          padding: 1px 4px;
          border-radius: 3px;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.cell-actions) {
          text-align: right;
          padding-right: 14px !important;
          width: 56px;
        }
        :global(.row-actions) {
          display: inline-flex;
          gap: 6px;
          justify-content: flex-end;
          align-items: center;
        }
        :global(.row-btn) {
          background: transparent; border: 0; cursor: pointer;
          font-size: 13px;
          color: var(--text-mute);
          opacity: 0;
          transition: opacity .15s, color .15s;
          padding: 0;
          line-height: 1;
        }
        :global(.screener-row:hover .row-btn) { opacity: 1; }
        :global(.row-btn.star-on) {
          color: var(--acc-star);
          opacity: 1;
        }
        :global(.row-btn.hide-btn:hover) {
          color: var(--acc-down);
        }
        :global(.row-btn.hide-on) {
          color: var(--acc-warn);
          opacity: 1;
        }
        /* Rows marked as hidden — only visible when Show Hidden is on.
           Dim the entire row so the user can spot+unhide them quickly. */
        :global(.screener-row.row-hidden) {
          opacity: 0.45;
        }
        :global(.screener-row.row-hidden:hover) {
          opacity: 0.85;
        }
      `}</style>
    </div>
  );
}

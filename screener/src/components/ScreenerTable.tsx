"use client";

import { useEffect, useMemo, useState } from "react";
import { AssetData } from "@/lib/types";
import { SECTORS } from "@/config/sectors";
import { Timeframe as HeatmapTF } from "./TimeframeToggle";
import type { ScreenerRow } from "@/app/api/screener/route";
import Sparkline from "./Sparkline";
import RSIGauge from "./RSIGauge";
import MAGrid from "./MAGrid";
import { useAttention, attentionTone } from "@/lib/useAttention";

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
  | "volume24h"
  | "funding_apr"
  | "oi_usd"
  | "oi_change_24h"
  | "oi_change_7d"
  | "funding_avg_apr"
  | "vol_oi";

function mapToCandleTF(tf: HeatmapTF): "1h" | "4h" | "1d" {
  if (tf === "1h") return "1h";
  if (tf === "4h") return "4h";
  return "1d";
}

// Annualized funding APR. HL funds HOURLY (unlike Binance's 8h), so
// the hourly rate × 24 × 365 = 8760 gives the annualized number.
// Convention: positive funding = longs pay shorts (overcrowded longs),
// so we color red. Negative = shorts pay longs (overcrowded shorts),
// color green. This is the OPPOSITE of price direction — a positive
// APR means a contrarian short bias makes sense.
function fundingApr(hourlyRate: number | null): number | null {
  if (hourlyRate == null || !Number.isFinite(hourlyRate)) return null;
  return hourlyRate * 8760 * 100; // express as percentage
}

function fmtFundingApr(apr: number | null): string {
  if (apr == null) return "—";
  const sign = apr > 0 ? "+" : "";
  return `${sign}${apr.toFixed(1)}%`;
}

// Color tier for funding APR:
//   |APR| < 10%   = mute (calm tape)
//   10–50%        = subtle tone (longs/shorts paying noticeable cost)
//   50–100%       = mustard (extreme — squeeze setup territory)
//   100%+         = strong red/green (very crowded — high reversal odds)
function fundingClass(apr: number | null): string {
  if (apr == null) return "tone-mute";
  const abs = Math.abs(apr);
  if (abs < 10) return "tone-mute";
  if (abs >= 100) return apr > 0 ? "tone-down" : "tone-up";
  if (abs >= 50) return "tone-warn";
  return apr > 0 ? "tone-down" : "tone-up";
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

// Signed compact USD, for OI deltas: "+$41.2M" / "-$3.1M".
// Sign carries the meaning here (money in vs money out), so it's always
// explicit — unlike fmtVol, which only ever renders magnitudes.
function fmtSignedVol(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) < 1) return "$0";
  return `${n > 0 ? "+" : "−"}${fmtVol(Math.abs(n))}`;
}

// Tone for an OI delta. NOTE: this is deliberately NOT price semantics —
// green means open interest grew (new money took positions), red means it
// shrank (positions closed). A red-price/green-OI row is the informative
// combination, not a contradiction: it's fresh shorts pressing a decline.
// Sub-1% moves are noise on a 24h horizon, so they read flat.
function oiToneClass(pct: number | null): string {
  if (pct == null) return "tone-mute";
  if (pct > 1) return "tone-up";
  if (pct < -1) return "tone-down";
  return "tone-flat";
}

// Turnover: 24h volume / open interest. Below ~0.5x the book is parked
// (hedges, passive exposure); above ~2x it's being actively churned.
function fmtVolOi(r: number | null): string {
  if (r == null || !Number.isFinite(r)) return "—";
  return `${r.toFixed(1)}×`;
}

function volOiClass(r: number | null): string {
  if (r == null) return "tone-mute";
  if (r >= 2) return "tone-warn";
  if (r < 0.5) return "tone-mute";
  return "";
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
  // Attention radar lookup — drives the small accel chip next to the
  // symbol so social context is visible while scanning TA columns.
  const { bySymbol: attention } = useAttention();
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
      // Existing columns keep their -Infinity sentinel (unchanged ordering).
      // The flow columns return null instead, which sorts last in BOTH
      // directions — "sort by biggest OI outflow" is a real read, and a
      // wall of no-data rows at the top would bury it.
      const pick = (x: AssetData, s: ScreenerRow | undefined): number | string | null => {
        switch (sortKey) {
          case "name": return x.name;
          case "price": return x.price;
          case "change1h": return x.change1h ?? -Infinity;
          case "change4h": return x.change4h ?? -Infinity;
          case "change24h": return x.change24h ?? -Infinity;
          case "change7d": return x.change7d ?? -Infinity;
          case "vol_ratio": return s?.vol_ratio ?? -Infinity;
          case "ath_pct": return s?.ath_pct ?? -Infinity;
          case "rsi": return s?.rsi ?? -Infinity;
          case "volume24h": return x.volume24h;
          case "funding_apr": return fundingApr(x.fundingRate) ?? -Infinity;
          case "oi_usd": return x.oiUsd;
          case "oi_change_24h": return x.oiChange24hUsd;
          case "oi_change_7d": return x.oiChange7dUsd;
          case "funding_avg_apr": return fundingApr(x.fundingAvg24h);
          case "vol_oi": return x.volOiRatio;
        }
      };
      const va = pick(a, sa);
      const vb = pick(b, sb);
      const dir = sortAsc ? 1 : -1;
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
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
                <th style={thRight} onClick={() => handleSort("oi_usd")} title="Open interest in USD (HL reports it in coins; this is coins × price).">OI{arr("oi_usd")}</th>
                <th style={thRight} onClick={() => handleSort("oi_change_24h")} title="Change in USD open interest vs 24h ago. Green = OI grew (new money took positions), red = OI shrank (positions closed). This is money flow, not price direction.">ΔOI 24H{arr("oi_change_24h")}</th>
                <th style={thRight} onClick={() => handleSort("oi_change_7d")} title="Change in USD open interest vs 7d ago.">ΔOI 7D{arr("oi_change_7d")}</th>
                <th style={thRight} onClick={() => handleSort("vol_oi")} title="24h volume ÷ open interest. <0.5× = parked positions, >2× = actively churned.">Vol/OI{arr("vol_oi")}</th>
                <th style={thRight} onClick={() => handleSort("vol_ratio")}>Vol Ratio{arr("vol_ratio")}</th>
                <th style={thRight} onClick={() => handleSort("funding_apr")} title="Annualized funding APR, current print. + = longs pay shorts.">Fund APR{arr("funding_apr")}</th>
                <th style={thRight} onClick={() => handleSort("funding_avg_apr")} title="Mean funding APR over the last 24h. The spot print whipsaws on thin markets; this is what separates structural crowding from noise.">F̄ 24H{arr("funding_avg_apr")}</th>
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
                    <td className="cell-sym">
                      <span className="sym">{a.symbol}</span>
                      {(() => {
                        const at = attention.get(a.symbol);
                        // Chip only when the radar classified the symbol —
                        // an unclassified 1.3× on every row would be noise.
                        if (!at?.klass) return null;
                        const tone = attentionTone(at.klass);
                        return (
                          <span
                            className={`attn-chip attn-${tone}`}
                            title={`Attention: ${at.mentions} mentions, ${at.accel.toFixed(1)}× baseline (${at.klass.replace("_", " ")})`}
                          >
                            👁{at.accel.toFixed(1)}×
                          </span>
                        );
                      })()}
                    </td>
                    <td className="cell-num cell-price">${fmtPrice(a.price)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change1h)}`}>{fmtPct(a.change1h, true)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change4h)}`}>{fmtPct(a.change4h, true)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change24h)}`}>{fmtPct(a.change24h)}</td>
                    <td className={`cell-num pct-tri ${toneClass(a.change7d)}`}>{fmtPct(a.change7d)}</td>
                    <td className="cell-num cell-vol">{fmtVol(a.volume24h)}</td>
                    <td className="cell-num">
                      {a.oiUsd == null
                        ? <span style={{ color: "var(--text-mute)" }}>—</span>
                        : fmtVol(a.oiUsd)}
                    </td>
                    <td className={`cell-num ${oiToneClass(a.oiChange24hPct)}`}>
                      {a.oiChange24hUsd == null ? (
                        <span style={{ color: "var(--text-mute)" }}>—</span>
                      ) : (
                        <>
                          {fmtSignedVol(a.oiChange24hUsd)}
                          {a.oiChange24hPct != null && (
                            <span style={{ fontSize: 9, color: "var(--text-mute)", marginLeft: 4 }}>
                              {fmtPct(a.oiChange24hPct)}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={`cell-num ${oiToneClass(a.oiChange7dPct)}`}>
                      {a.oiChange7dUsd == null ? (
                        <span style={{ color: "var(--text-mute)" }}>—</span>
                      ) : (
                        <>
                          {fmtSignedVol(a.oiChange7dUsd)}
                          {a.oiChange7dPct != null && (
                            <span style={{ fontSize: 9, color: "var(--text-mute)", marginLeft: 4 }}>
                              {fmtPct(a.oiChange7dPct)}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={`cell-num ${volOiClass(a.volOiRatio)}`}>
                      {fmtVolOi(a.volOiRatio)}
                    </td>
                    <td className="cell-num">
                      {sr?.vol_ratio != null ? (
                        <span className={sr.vol_ratio >= 2 ? "vol-ratio-hot" : "vol-ratio"}>
                          {sr.vol_ratio.toFixed(2)}×
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-mute)" }}>—</span>
                      )}
                    </td>
                    <td className={`cell-num ${fundingClass(fundingApr(a.fundingRate))}`}>
                      {fmtFundingApr(fundingApr(a.fundingRate))}
                    </td>
                    <td className={`cell-num ${fundingClass(fundingApr(a.fundingAvg24h))}`}>
                      {fmtFundingApr(fundingApr(a.fundingAvg24h))}
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
        :global(.attn-chip) {
          font-size: 9px;
          padding: 1px 4px;
          margin-left: 6px;
          border-radius: 3px;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
          vertical-align: middle;
        }
        :global(.attn-chip.attn-warn) {
          color: var(--acc-warn);
          background: color-mix(in oklab, var(--acc-warn) 14%, transparent);
        }
        :global(.attn-chip.attn-up) {
          color: var(--acc-up);
          background: color-mix(in oklab, var(--acc-up) 14%, transparent);
        }
        :global(.attn-chip.attn-down) {
          color: var(--acc-down);
          background: color-mix(in oklab, var(--acc-down) 14%, transparent);
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

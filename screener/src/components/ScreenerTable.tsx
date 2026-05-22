"use client";

import { useEffect, useMemo, useState } from "react";
import { AssetData } from "@/lib/types";
import { SECTORS } from "@/config/sectors";
import { Timeframe as HeatmapTF } from "./TimeframeToggle";
import type { ScreenerRow } from "@/app/api/screener/route";
import Sparkline from "./Sparkline";
import RSIGauge from "./RSIGauge";
import MAGrid from "./MAGrid";

// The screener table is the "research" view — dense, sortable, MA-grid +
// sparklines + RSI gauges. Coexists with the heatmap; toggled at page level.
//
// Data model: we LEFT JOIN pre-filtered AssetData against the response of
// /api/screener?tf=X. Symbols missing from the screener payload still
// render (showing — for indicator cells) so the user isn't confused by a
// row count that doesn't match the heatmap.

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

// Heatmap TF -> screener candle TF. "24h" and "7d" both map to 1d candles
// because the MA grid is fundamentally a chart-level concept and "daily MA"
// is what users intuit when they pick either of those buckets.
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

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function pctColor(n: number | null): string {
  if (n == null) return "text-gray-600";
  if (n > 0) return "text-emerald-400";
  if (n < 0) return "text-red-400";
  return "text-gray-400";
}

function fmtVol(n: number): string {
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
}

export default function ScreenerTable({
  assets, isLoading, timeframe, onSelectAsset,
  showWatchlistOnly, watchlist, onToggleWatch,
}: Props) {
  const candleTf = mapToCandleTF(timeframe);
  const [screenerRows, setScreenerRows] = useState<ScreenerRow[]>([]);
  const [screenerLoading, setScreenerLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("volume24h");
  const [sortAsc, setSortAsc] = useState(false);

  // Re-fetch when the candle TF changes. We don't bother polling on a
  // timer here because /api/screener has its own 60s server cache; the
  // heatmap's polling already drives /api/markets churn.
  useEffect(() => {
    let cancelled = false;
    setScreenerLoading(true);
    fetch(`/api/screener?tf=${candleTf}`)
      .then((r) => r.json())
      .then((data: ScreenerRow[]) => {
        if (cancelled) return;
        if (Array.isArray(data)) setScreenerRows(data);
        setScreenerLoading(false);
      })
      .catch(() => {
        if (!cancelled) setScreenerLoading(false);
      });
    const interval = setInterval(() => {
      fetch(`/api/screener?tf=${candleTf}`)
        .then((r) => r.json())
        .then((data: ScreenerRow[]) => {
          if (!cancelled && Array.isArray(data)) setScreenerRows(data);
        })
        .catch(() => {});
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [candleTf]);

  // Map for O(1) row enrichment.
  const screenerBySymbol = useMemo(() => {
    const m = new Map<string, ScreenerRow>();
    for (const r of screenerRows) m.set(r.symbol, r);
    return m;
  }, [screenerRows]);

  const visibleAssets = useMemo(() => {
    return showWatchlistOnly
      ? assets.filter((a) => watchlist.has(a.symbol))
      : assets;
  }, [assets, showWatchlistOnly, watchlist]);

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
      // Sensible per-column default: most users want desc on numeric cols
      // (highest first) and asc on name.
      setSortAsc(key === "name");
    }
  };

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortAsc ? " ▲" : " ▼") : "";

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          <span className="text-sm text-gray-500">Loading markets...</span>
        </div>
      </div>
    );
  }

  if (showWatchlistOnly && sorted.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="text-center">
          <span className="text-2xl block mb-2">☆</span>
          <span className="text-sm text-gray-500">No assets in your watchlist yet.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-6">
      <div className="bg-surface/50 rounded-xl border border-white/5 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">
              Screener
            </span>
            <span className="text-[10px] font-mono text-gray-600 bg-gray-800/50 px-1.5 py-0.5 rounded">
              {sorted.length} / {assets.length}
            </span>
            <span className="text-[10px] font-mono text-gray-600 ml-2">
              MAs: {candleTf}
            </span>
          </div>
          {screenerLoading && (
            <span className="text-[10px] text-gray-600">computing indicators…</span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-[10px] text-gray-500 uppercase tracking-wider border-b border-white/5">
                <th className="py-2 px-2 w-8 text-right">#</th>
                <th className="py-2 px-2 cursor-pointer hover:text-gray-300" onClick={() => handleSort("name")}>
                  Name{sortArrow("name")}
                </th>
                <th className="py-2 px-2">Sym</th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("price")}>
                  Price{sortArrow("price")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("change1h")}>
                  1h%{sortArrow("change1h")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("change4h")}>
                  4h%{sortArrow("change4h")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("change24h")}>
                  24h%{sortArrow("change24h")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("change7d")}>
                  7d%{sortArrow("change7d")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("volume24h")}>
                  Vol 24h{sortArrow("volume24h")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("vol_ratio")}>
                  Vol Ratio{sortArrow("vol_ratio")}
                </th>
                <th className="py-2 px-2 text-right cursor-pointer hover:text-gray-300" onClick={() => handleSort("ath_pct")}>
                  ATH%{sortArrow("ath_pct")}
                </th>
                <th className="py-2 px-2 text-center">Spark</th>
                <th className="py-2 px-2 cursor-pointer hover:text-gray-300" onClick={() => handleSort("rsi")}>
                  RSI{sortArrow("rsi")}
                </th>
                <th className="py-2 px-2">MAs ({candleTf})</th>
                <th className="py-2 px-2 w-6" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((a, i) => {
                const sr = screenerBySymbol.get(a.symbol) ?? null;
                const sectorColor = SECTORS[a.sector]?.color ?? "#64748B";
                const isWatched = watchlist.has(a.symbol);
                return (
                  <tr
                    key={a.symbol}
                    className="border-b border-white/3 hover:bg-white/3 cursor-pointer transition-colors group"
                    onClick={() => onSelectAsset(a.symbol)}
                  >
                    <td className="py-1.5 px-2 text-right text-[10px] text-gray-600 font-mono">{i + 1}</td>
                    <td className="py-1.5 px-2">
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: sectorColor }} />
                        <span className="text-xs text-gray-200 truncate max-w-[140px]">{a.name}</span>
                      </div>
                    </td>
                    <td className="py-1.5 px-2 text-xs font-semibold text-white font-mono">{a.symbol}</td>
                    <td className="py-1.5 px-2 text-right text-xs font-mono text-white">${fmtPrice(a.price)}</td>
                    <td className={`py-1.5 px-2 text-right text-xs font-mono ${pctColor(a.change1h)}`}>{fmtPct(a.change1h)}</td>
                    <td className={`py-1.5 px-2 text-right text-xs font-mono ${pctColor(a.change4h)}`}>{fmtPct(a.change4h)}</td>
                    <td className={`py-1.5 px-2 text-right text-xs font-mono ${pctColor(a.change24h)}`}>{fmtPct(a.change24h)}</td>
                    <td className={`py-1.5 px-2 text-right text-xs font-mono ${pctColor(a.change7d)}`}>{fmtPct(a.change7d)}</td>
                    <td className="py-1.5 px-2 text-right text-[10px] font-mono text-gray-400">{fmtVol(a.volume24h)}</td>
                    <td className="py-1.5 px-2 text-right text-[10px] font-mono">
                      {sr?.vol_ratio != null ? (
                        <span className={sr.vol_ratio >= 2 ? "text-amber-400" : "text-gray-500"}>
                          {sr.vol_ratio.toFixed(2)}x
                        </span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-right text-[10px] font-mono">
                      {sr?.ath_pct != null ? (
                        <span className={sr.ath_pct < -50 ? "text-red-400" : sr.ath_pct < -20 ? "text-amber-400" : "text-gray-400"}>
                          {sr.ath_pct.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-center">
                      <Sparkline data={sr?.sparkline ?? []} />
                    </td>
                    <td className="py-1.5 px-2">
                      <RSIGauge value={sr?.rsi ?? null} />
                    </td>
                    <td className="py-1.5 px-2">
                      <MAGrid row={sr} />
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleWatch(a.symbol);
                        }}
                        className={`text-sm leading-none transition-all ${
                          isWatched
                            ? "text-yellow-400 opacity-100"
                            : "text-gray-700 opacity-0 group-hover:opacity-100"
                        }`}
                        title={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                      >
                        {isWatched ? "★" : "☆"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

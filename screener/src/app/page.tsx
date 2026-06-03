"use client";

import { useState, useEffect, useMemo } from "react";
import MacroBar from "@/components/MacroBar";
import HypePressureCard from "@/components/HypePressureCard";
import TimeframeToggle, { Timeframe } from "@/components/TimeframeToggle";
import Heatmap from "@/components/Heatmap";
import ScreenerTable from "@/components/ScreenerTable";
import SignalScanner from "@/components/SignalScanner";
import AssetDetailModal from "@/components/AssetDetailModal";
import { FilterPanel } from "@/components/FilterPanel";
import { useWatchlist } from "@/lib/useWatchlist";
import { useHidelist } from "@/lib/useHidelist";
import { useFilters, passesFilters } from "@/lib/useFilters";
import { AssetData } from "@/lib/types";

type View = "heatmap" | "table";
const VIEW_STORAGE_KEY = "asset-screener-view";

export default function Home() {
  const [timeframe, setTimeframe] = useState<Timeframe>("24h");
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const { watchlist, toggle, count } = useWatchlist();
  const { hidden, toggle: toggleHide, count: hiddenCount } = useHidelist();
  const [showHidden, setShowHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const [view, setView] = useState<View>("heatmap");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "table" || stored === "heatmap") setView(stored);
  }, []);
  function changeView(next: View) {
    setView(next);
    if (typeof window !== "undefined") {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    }
  }

  const { filters, setFilter, clearFilters, activeCount } = useFilters();
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);

  const [allAssets, setAllAssets] = useState<AssetData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Track the most recent fetch outcome so the UI can distinguish
  // "no data" (initial load) from "backend down" (existing data is
  // stale because /api/markets failed). For a financial dashboard
  // this difference matters — silently showing 30s-old data without
  // signaling the upstream is unreachable is worse than telling the
  // user something is wrong.
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/markets");
        if (!res.ok) {
          setMarketsError(`HTTP ${res.status}`);
          return;
        }
        const data = await res.json();
        setAllAssets(data);
        setMarketsError(null);
        setLastFetchAt(Date.now());
      } catch (err) {
        setMarketsError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsLoading(false);
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // Filter pipeline: filter panel rules → hide list → search query.
  // Hide list is applied here (not just at view level) so signals,
  // sector RS, and screener data downstream all skip hidden assets.
  // When `showHidden` is on, hidden assets DO appear (dimmed) so the
  // user can review + unhide.
  const filteredAssets = useMemo(() => {
    let arr = allAssets.filter((a) => passesFilters(a, filters));
    if (!showHidden) {
      arr = arr.filter((a) => !hidden.has(a.symbol));
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      arr = arr.filter(
        (a) => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
      );
    }
    return arr;
  }, [allAssets, filters, searchQuery, hidden, showHidden]);

  const passingSymbols: Set<string> | null =
    allAssets.length === 0 ? null : new Set(filteredAssets.map((a) => a.symbol));

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {filterPanelOpen && (
        <FilterPanel
          filters={filters}
          onChange={setFilter}
          onClear={clearFilters}
          onClose={() => setFilterPanelOpen(false)}
        />
      )}

      <MacroBar />

      {/* Backend health banner — only renders when /api/markets has
          failed at least once since the last successful fetch. The
          existing display continues to show the LAST GOOD data so
          users can still see prices, but the banner makes clear the
          numbers may be stale. Mustard-bordered to be visible
          without competing with the trade-action colors (green/red). */}
      {marketsError && (
        <div
          role="alert"
          style={{
            padding: "8px 24px",
            background: "color-mix(in oklab, var(--acc-warn) 6%, var(--bg))",
            borderBottom: ".5px solid color-mix(in oklab, var(--acc-warn) 35%, transparent)",
            color: "var(--acc-warn)",
            fontSize: 11,
            fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
            letterSpacing: ".06em",
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span>⚠</span>
          <span>Backend unreachable — showing last known data{lastFetchAt ? ` (${Math.round((Date.now() - lastFetchAt) / 1000)}s ago)` : ""}</span>
          <span style={{ marginLeft: "auto", color: "var(--text-mute)" }}>
            {marketsError}
          </span>
        </div>
      )}

      {/* HYPE TWAP buy-pressure card. Always visible — small enough to
          sit between macro + top bar without crowding either. */}
      <div style={{ padding: "12px 24px 0", display: "flex", justifyContent: "flex-end" }}>
        <HypePressureCard />
      </div>

      {/* ── Top bar ─────────────────────────────────────────── */}
      <div className="topbar">
        <div className="topbar-l">
          {/* Title: Asset[Screener] — "Asset" muted, "[Screener]" mustard
              with mute brackets via .title-bracket class. */}
          <h1 className="title">
            <span className="title-1">Asset</span>
            <span className="title-2 sym">Screener</span>
          </h1>

          {/* Search input — filters table + heatmap by name OR symbol */}
          <label className="search">
            <span className="search-icon">⌕</span>
            <input
              type="text"
              placeholder="Search symbol or name…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="search-clear"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                style={{ background: "transparent", border: 0, color: "var(--text-mute)", cursor: "pointer", padding: "2px 4px" }}
              >
                ✕
              </button>
            )}
          </label>
        </div>

        <div className="topbar-r">
          {/* View toggle */}
          <div className="seg">
            <button onClick={() => changeView("heatmap")} className={view === "heatmap" ? "on" : ""}>
              Heatmap
            </button>
            <button onClick={() => changeView("table")} className={view === "table" ? "on" : ""}>
              Table
            </button>
          </div>

          {/* Filters */}
          <button
            onClick={() => setFilterPanelOpen((p) => !p)}
            className="btn-ghost"
            style={activeCount > 0 ? {
              color: "var(--acc-warn)",
              borderColor: "color-mix(in oklab, var(--acc-warn) 40%, transparent)",
            } : undefined}
          >
            <svg width="11" height="11" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
              />
            </svg>
            Filters
            {activeCount > 0 && <span className="btn-count">{activeCount}</span>}
          </button>

          {/* Watchlist */}
          <button
            onClick={() => setShowWatchlist(!showWatchlist)}
            className={`btn-ghost ${showWatchlist ? "on-watch" : ""}`}
            title="Show only watchlisted (starred) assets"
          >
            <span>{showWatchlist ? "★" : "☆"}</span>
            Watchlist
            {count > 0 && <span className="btn-count">{count}</span>}
          </button>

          {/* Hidden — only rendered if user has hidden at least one asset.
              Hides the chrome unless it's relevant. */}
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowHidden(!showHidden)}
              className="btn-ghost"
              style={showHidden ? {
                color: "var(--acc-warn)",
                borderColor: "color-mix(in oklab, var(--acc-warn) 40%, transparent)",
              } : undefined}
              title={showHidden
                ? "Hide the hidden assets again"
                : "Show hidden assets (dimmed) so you can review or unhide"}
            >
              <span>{showHidden ? "◉" : "◯"}</span>
              Hidden
              <span className="btn-count">{hiddenCount}</span>
            </button>
          )}

          {/* Terminal — prominent (accented) link to the read-only info
              terminal: catalyst news feed, live prices, derivs radar.
              Mustard-highlighted so it stands out from the ghost buttons. */}
          <a
            href="/terminal"
            className="btn-ghost"
            title="Open the live terminal — news feed, prices, derivs radar"
            style={{
              textDecoration: "none",
              color: "var(--acc-warn)",
              borderColor: "color-mix(in oklab, var(--acc-warn) 45%, transparent)",
              background: "color-mix(in oklab, var(--acc-warn) 9%, transparent)",
            }}
          >
            <span>⌗</span>
            Terminal
          </a>

          {/* Journal — link out to the trades table view. Same chrome as
              the watchlist button, no count badge (open count would
              add a fetch on every page load just for the badge). */}
          <a
            href="/journal"
            className="btn-ghost"
            title="Open the trade journal"
            style={{ textDecoration: "none" }}
          >
            <span>≡</span>
            Journal
          </a>

          <TimeframeToggle selected={timeframe} onChange={setTimeframe} />
        </div>
      </div>

      {/* ── Main surface ────────────────────────────────────── */}
      {view === "heatmap" ? (
        <Heatmap
          assets={filteredAssets}
          isLoading={isLoading}
          timeframe={timeframe}
          onSelectAsset={setSelectedAsset}
          showWatchlistOnly={showWatchlist}
          watchlist={watchlist}
          onToggleWatch={toggle}
          hidden={hidden}
          onToggleHide={toggleHide}
          showHidden={showHidden}
        />
      ) : (
        <ScreenerTable
          assets={filteredAssets}
          isLoading={isLoading}
          timeframe={timeframe}
          onSelectAsset={setSelectedAsset}
          showWatchlistOnly={showWatchlist}
          watchlist={watchlist}
          onToggleWatch={toggle}
          hidden={hidden}
          onToggleHide={toggleHide}
          showHidden={showHidden}
        />
      )}

      <div style={{ padding: "0 24px 24px" }}>
        <SignalScanner
          onSelectAsset={setSelectedAsset}
          allowedSymbols={passingSymbols}
        />
      </div>

      {selectedAsset && (
        <AssetDetailModal
          symbol={selectedAsset}
          onClose={() => setSelectedAsset(null)}
        />
      )}

      <style jsx>{`
        .topbar {
          display: flex; justify-content: space-between; align-items: center;
          padding: 18px 24px 14px;
          gap: 16px;
        }
        .topbar-l {
          display: flex; align-items: center; gap: 18px; min-width: 0; flex: 1;
        }
        .topbar-r {
          display: flex; align-items: center; gap: 8px; flex-shrink: 0;
          flex-wrap: wrap;
        }
        .title {
          margin: 0; font-size: 14px; font-weight: 500;
          letter-spacing: -0.01em;
        }
        :global(.title-1) {
          color: var(--text-mute);
          margin-right: 0.35ch;
          font-family: var(--font-geist-mono), ui-monospace, monospace;
        }
        :global(.title-2) {
          color: var(--acc-warn);
          font-weight: 500;
        }
        :global(.search-icon) {
          color: var(--text-mute);
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import MacroBar from "@/components/MacroBar";
import TimeframeToggle, { Timeframe } from "@/components/TimeframeToggle";
import Heatmap from "@/components/Heatmap";
import SignalScanner from "@/components/SignalScanner";
import AssetDetailModal from "@/components/AssetDetailModal";
import { FilterPanel } from "@/components/FilterPanel";
import { useWatchlist } from "@/lib/useWatchlist";
import { useFilters, passesFilters } from "@/lib/useFilters";
import { AssetData } from "@/lib/types";

export default function Home() {
  const [timeframe, setTimeframe] = useState<Timeframe>("24h");
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const { watchlist, toggle, count } = useWatchlist();

  // Filter state
  const { filters, setFilter, clearFilters, activeCount } = useFilters();
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);

  // Markets data — single source of truth for filtering
  const [allAssets, setAllAssets] = useState<AssetData[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/markets");
        if (res.ok) setAllAssets(await res.json());
        // On error: keep existing state (don't hide signals)
      } catch {
        // ignore — keep existing allAssets
      } finally {
        setIsLoading(false);
      }
    }
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // Derived values — recomputed on every render when allAssets or filters change
  const filteredAssets = allAssets.filter((a) => passesFilters(a, filters));

  // null = data not loaded yet → SignalScanner shows all signals
  const passingSymbols: Set<string> | null =
    allAssets.length === 0
      ? null
      : new Set(filteredAssets.map((a) => a.symbol));

  return (
    <div className="min-h-screen flex flex-col">
      {/* Slide-in filter panel (fixed position, conditionally rendered) */}
      {filterPanelOpen && (
        <FilterPanel
          filters={filters}
          onChange={setFilter}
          onClear={clearFilters}
          onClose={() => setFilterPanelOpen(false)}
        />
      )}

      <MacroBar />

      <div className="flex items-center justify-between px-6 py-4">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-white">Asset</span>{" "}
          <span className="text-gray-500">Screener</span>
        </h1>
        <div className="flex items-center gap-3">
          {/* Filters button */}
          <button
            onClick={() => setFilterPanelOpen((prev) => !prev)}
            className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              activeCount > 0
                ? "bg-violet-600/20 border-violet-500/50 text-violet-300"
                : "bg-transparent border-white/10 text-gray-500 hover:text-gray-300 hover:border-white/20"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z"
              />
            </svg>
            Filters
            {activeCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 bg-violet-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                {activeCount}
              </span>
            )}
          </button>

          {/* Watchlist button */}
          <button
            onClick={() => setShowWatchlist(!showWatchlist)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
              showWatchlist
                ? "bg-yellow-400/10 border-yellow-400/30 text-yellow-400"
                : "bg-transparent border-white/10 text-gray-500 hover:text-gray-300 hover:border-white/20"
            }`}
          >
            <span>{showWatchlist ? "\u2605" : "\u2606"}</span>
            Watchlist
            {count > 0 && (
              <span className="text-[10px] font-mono bg-white/10 px-1.5 py-0.5 rounded">
                {count}
              </span>
            )}
          </button>

          <TimeframeToggle selected={timeframe} onChange={setTimeframe} />
        </div>
      </div>

      <Heatmap
        assets={filteredAssets}
        isLoading={isLoading}
        timeframe={timeframe}
        onSelectAsset={setSelectedAsset}
        showWatchlistOnly={showWatchlist}
        watchlist={watchlist}
        onToggleWatch={toggle}
      />

      <div className="px-4 pb-6 mt-2">
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
    </div>
  );
}

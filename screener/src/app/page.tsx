"use client";

import React, { useState } from "react";
import MacroBar from "@/components/MacroBar";
import TimeframeToggle, { Timeframe } from "@/components/TimeframeToggle";
import Heatmap from "@/components/Heatmap";
import SignalScanner from "@/components/SignalScanner";
import AssetDetailModal from "@/components/AssetDetailModal";
import { useWatchlist } from "@/lib/useWatchlist";

export default function Home() {
  const [timeframe, setTimeframe] = useState<Timeframe>("24h");
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [allowedSymbols, setAllowedSymbols] = useState<Set<string> | null>(null);
  const { watchlist, toggle, count } = useWatchlist();

  // Load markets data to get allowed symbols
  React.useEffect(() => {
    fetch("/api/markets")
      .then((r) => r.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) {
          setAllowedSymbols(new Set(data.map((a) => a.symbol)));
        }
      })
      .catch(() => {
        // On error, set to empty set so all signals are hidden
        setAllowedSymbols(new Set());
      });
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <MacroBar />

      <div className="flex items-center justify-between px-6 py-4">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-white">Asset</span>{" "}
          <span className="text-gray-500">Screener</span>
        </h1>
        <div className="flex items-center gap-3">
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
        timeframe={timeframe}
        onSelectAsset={setSelectedAsset}
        showWatchlistOnly={showWatchlist}
        watchlist={watchlist}
        onToggleWatch={toggle}
      />

      <div className="px-4 pb-6 mt-2">
        <SignalScanner onSelectAsset={setSelectedAsset} allowedSymbols={allowedSymbols} />
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

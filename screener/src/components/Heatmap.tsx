"use client";

import { AssetData } from "@/lib/types";
import { SECTORS, Sector } from "@/config/sectors";
import HeatmapTile from "./HeatmapTile";
import { Timeframe } from "./TimeframeToggle";

interface Props {
  assets: AssetData[];              // pre-filtered by page.tsx
  isLoading: boolean;
  timeframe: Timeframe;
  onSelectAsset: (symbol: string) => void;
  showWatchlistOnly: boolean;
  watchlist: Set<string>;
  onToggleWatch: (symbol: string) => void;
}

const SECTOR_ORDER: Sector[] = [
  "majors", "stocks", "indices", "commodities", "preipo",
  "l1", "defi", "ai", "infra", "meme", "gaming",
  "crypto-major", "crypto-alt",
];

export default function Heatmap({ assets, isLoading, timeframe, onSelectAsset, showWatchlistOnly, watchlist, onToggleWatch }: Props) {
  const filtered = showWatchlistOnly
    ? assets.filter((a) => watchlist.has(a.symbol))
    : assets;

  // Group by sector
  const grouped = new Map<Sector, AssetData[]>();
  for (const asset of filtered) {
    const list = grouped.get(asset.sector) || [];
    list.push(asset);
    grouped.set(asset.sector, list);
  }

  for (const [, list] of grouped) {
    list.sort((a, b) => b.volume24h - a.volume24h);
  }

  const activeSectors = SECTOR_ORDER.filter(
    (s) => grouped.has(s) && grouped.get(s)!.length > 0
  );

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

  if (showWatchlistOnly && activeSectors.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <div className="text-center">
          <span className="text-2xl block mb-2">&#9734;</span>
          <span className="text-sm text-gray-500">No assets in your watchlist yet.</span>
          <br />
          <span className="text-xs text-gray-600 mt-1">Hover over any asset tile and click the star to add it.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
      {activeSectors.map((sectorId) => {
        const config = SECTORS[sectorId];
        const sectorAssets = grouped.get(sectorId)!;
        const totalVol = sectorAssets.reduce((s, a) => s + a.volume24h, 0);

        return (
          <div
            key={sectorId}
            className="bg-surface/50 rounded-xl border border-white/5 overflow-hidden"
          >
            <div
              className="flex items-center justify-between px-4 py-2.5 border-b border-white/5"
              style={{ borderBottomColor: `${config.color}30` }}
            >
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: config.color }}
                />
                <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">
                  {config.label}
                </span>
              </div>
              {totalVol > 0 && (
                <span className="text-[10px] font-mono text-gray-600">
                  ${(totalVol / 1_000_000).toFixed(1)}M vol
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2 p-3">
              {sectorAssets.map((asset) => (
                <HeatmapTile
                  key={asset.symbol}
                  asset={asset}
                  timeframe={timeframe}
                  onClick={() => onSelectAsset(asset.symbol)}
                  isWatched={watchlist.has(asset.symbol)}
                  onToggleWatch={() => onToggleWatch(asset.symbol)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

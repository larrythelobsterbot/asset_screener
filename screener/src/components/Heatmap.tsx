"use client";

import { useEffect, useState } from "react";
import { AssetData } from "@/lib/types";
import { SECTORS, Sector } from "@/config/sectors";
import HeatmapTile from "./HeatmapTile";
import { Timeframe } from "./TimeframeToggle";

interface Props {
  timeframe: Timeframe;
  onSelectAsset: (symbol: string) => void;
}

// Order sectors should appear
const SECTOR_ORDER: Sector[] = [
  "stocks", "indices", "commodities", "preipo",
  "l1", "defi", "ai", "infra", "meme", "gaming",
  "crypto-major", "crypto-alt",
];

export default function Heatmap({ timeframe, onSelectAsset }: Props) {
  const [assets, setAssets] = useState<AssetData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = () =>
      fetch("/api/markets")
        .then((r) => r.json())
        .then((data: AssetData[]) => {
          if (Array.isArray(data)) setAssets(data);
          setLoading(false);
        })
        .catch(() => setLoading(false));

    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, []);

  // Group by sector
  const grouped = new Map<Sector, AssetData[]>();
  for (const asset of assets) {
    const list = grouped.get(asset.sector) || [];
    list.push(asset);
    grouped.set(asset.sector, list);
  }

  // Sort each group by volume descending
  for (const [, list] of grouped) {
    list.sort((a, b) => b.volume24h - a.volume24h);
  }

  // Filter to sectors that have assets, in defined order
  const activeSectors = SECTOR_ORDER.filter(
    (s) => grouped.has(s) && grouped.get(s)!.length > 0
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          <span className="text-sm text-gray-500">Loading markets...</span>
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
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

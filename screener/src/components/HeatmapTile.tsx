"use client";

import { AssetData } from "@/lib/types";
import { Timeframe } from "./TimeframeToggle";

interface Props {
  asset: AssetData;
  timeframe: Timeframe;
  onClick: () => void;
}

function getChange(asset: AssetData, tf: Timeframe): number | null {
  switch (tf) {
    case "1h": return asset.change1h;
    case "4h": return asset.change4h;
    case "24h": return asset.change24h;
    case "7d": return asset.change7d;
  }
}

function getIntensity(change: number | null): number {
  if (change === null) return 0;
  const abs = Math.abs(change);
  if (abs < 1) return 0.3;
  if (abs < 3) return 0.6;
  return 1;
}

export default function HeatmapTile({ asset, timeframe, onClick }: Props) {
  const change = getChange(asset, timeframe);
  const intensity = getIntensity(change);
  const isPositive = change !== null && change >= 0;

  const bgColor = change === null
    ? "rgba(31, 41, 55, 0.5)"
    : isPositive
    ? `rgba(34, 197, 94, ${intensity * 0.25})`
    : `rgba(239, 68, 68, ${intensity * 0.25})`;

  return (
    <button
      onClick={onClick}
      className="group relative flex flex-col items-start justify-between p-3 rounded-lg border border-white/5 hover:border-white/15 transition-all hover:scale-[1.02] min-w-[110px] text-left"
      style={{
        backgroundColor: bgColor,
        borderLeftColor: asset.sectorColor,
        borderLeftWidth: "3px",
      }}
    >
      <div className="flex items-center justify-between w-full">
        <span className="text-xs font-bold text-white/90 tracking-wide">
          {asset.symbol}
        </span>
        {asset.fundingRate !== null && Math.abs(asset.fundingRate) > 0.0001 && (
          <span className="text-[9px] text-yellow-400/70">F</span>
        )}
      </div>
      <div className="font-mono text-sm text-white mt-1">
        ${asset.price < 1
          ? asset.price.toPrecision(4)
          : asset.price.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
      </div>
      <div
        className={`font-mono text-xs mt-0.5 ${
          change === null
            ? "text-gray-500"
            : isPositive
            ? "text-positive"
            : "text-negative"
        }`}
      >
        {change !== null
          ? `${isPositive ? "+" : ""}${change.toFixed(2)}%`
          : "--"}
      </div>
    </button>
  );
}

"use client";

import { AssetData } from "@/lib/types";
import { Timeframe } from "./TimeframeToggle";

interface Props {
  asset: AssetData;
  timeframe: Timeframe;
  onClick: () => void;
  isWatched: boolean;
  onToggleWatch: () => void;
}

function getChange(asset: AssetData, tf: Timeframe): number | null {
  switch (tf) {
    case "1h": return asset.change1h;
    case "4h": return asset.change4h;
    case "24h": return asset.change24h;
    case "7d": return asset.change7d;
  }
}

// 6-tier color scale — intensity and hue shift as magnitude increases
function getPerfColor(change: number | null): string {
  if (change === null) return "rgba(255,255,255,0.03)";
  const abs = Math.abs(change);
  if (change >= 0) {
    if (abs < 0.5)  return "rgba(16,185,129,0.08)";   // near-flat — barely visible
    if (abs < 1)    return "rgba(16,185,129,0.18)";   // <1% — faint green
    if (abs < 2)    return "rgba(16,185,129,0.32)";   // 1-2% — light green
    if (abs < 5)    return "rgba(22,163,74,0.46)";    // 2-5% — medium green
    if (abs < 10)   return "rgba(22,163,74,0.62)";    // 5-10% — strong green
    return                  "rgba(21,128,61,0.80)";   // >10%  — deep green
  } else {
    if (abs < 0.5)  return "rgba(239,68,68,0.08)";    // near-flat
    if (abs < 1)    return "rgba(239,68,68,0.18)";    // <1% — faint red
    if (abs < 2)    return "rgba(239,68,68,0.32)";    // 1-2% — light red
    if (abs < 5)    return "rgba(220,38,38,0.46)";    // 2-5% — medium red
    if (abs < 10)   return "rgba(220,38,38,0.62)";    // 5-10% — strong red
    return                  "rgba(185,28,28,0.80)";   // >10%  — deep red
  }
}

function getChangeTextColor(change: number | null): string {
  if (change === null) return "text-gray-500";
  const abs = Math.abs(change);
  if (change >= 0) {
    if (abs < 1)  return "text-emerald-600";
    if (abs < 5)  return "text-emerald-400";
    if (abs < 10) return "text-emerald-300";
    return               "text-green-200";
  } else {
    if (abs < 1)  return "text-red-600";
    if (abs < 5)  return "text-red-400";
    if (abs < 10) return "text-red-300";
    return               "text-red-200";
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

export default function HeatmapTile({ asset, timeframe, onClick, isWatched, onToggleWatch }: Props) {
  const change = getChange(asset, timeframe);
  const isPositive = change !== null && change >= 0;

  const [sr, sg, sb] = hexToRgb(asset.sectorColor);
  const perfColor = getPerfColor(change);
  const sectorTint = `rgba(${sr}, ${sg}, ${sb}, 0.06)`;

  return (
    <div
      className="group relative flex flex-col items-start justify-between p-3 rounded-lg border border-white/5 hover:border-white/20 transition-all hover:scale-[1.02] min-w-[110px] text-left overflow-hidden cursor-pointer"
      style={{
        background: `linear-gradient(135deg, ${sectorTint}, ${perfColor})`,
      }}
      onClick={onClick}
    >
      {/* Sector accent line on top */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{ backgroundColor: asset.sectorColor, opacity: 0.6 }}
      />

      <div className="flex items-center justify-between w-full">
        <span className="text-xs font-bold text-white/90 tracking-wide">
          {asset.symbol}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleWatch();
          }}
          className={`text-sm leading-none transition-all ${
            isWatched
              ? "text-yellow-400 opacity-100"
              : "text-gray-600 opacity-0 group-hover:opacity-100"
          }`}
          title={isWatched ? "Remove from watchlist" : "Add to watchlist"}
        >
          {isWatched ? "\u2605" : "\u2606"}
        </button>
      </div>
      <div className="font-mono text-sm text-white mt-1">
        ${asset.price < 0.01
          ? asset.price.toPrecision(3)
          : asset.price < 1
          ? asset.price.toPrecision(4)
          : asset.price.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
      </div>
      <div
        className={`font-mono text-xs mt-0.5 font-semibold ${getChangeTextColor(change)}`}
      >
        {change !== null
          ? `${isPositive ? "+" : ""}${change.toFixed(2)}%`
          : "--"}
      </div>

      {/* Glow effect on hover */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none rounded-lg"
        style={{
          boxShadow: `inset 0 0 20px ${asset.sectorColor}15, 0 0 15px ${asset.sectorColor}08`,
        }}
      />
    </div>
  );
}

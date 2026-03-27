"use client";

import { Signal } from "@/lib/signals";
import { HL_PERP_SECTOR_MAP, SECTORS } from "@/config/sectors";

interface Props {
  signals: Signal[];
  onSelectAsset: (symbol: string) => void;
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function SignalFeed({ signals, onSelectAsset }: Props) {
  if (!signals.length) {
    return (
      <div className="text-center py-8 text-gray-600 text-sm">
        No active signals
      </div>
    );
  }

  return (
    <div className="space-y-2 max-h-[400px] overflow-y-auto">
      {signals.map((sig, i) => {
        const mapping = HL_PERP_SECTOR_MAP[sig.symbol];
        const sectorColor = mapping ? SECTORS[mapping.sector].color : "#64748B";

        return (
          <button
            key={`${sig.symbol}-${sig.type}-${i}`}
            onClick={() => onSelectAsset(sig.symbol)}
            className="w-full flex items-center gap-3 p-3 rounded-lg bg-surface/50 border border-white/5 hover:border-white/10 transition-all text-left"
          >
            <div
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: sectorColor }}
            />
            <span className="text-sm font-semibold text-white w-16 shrink-0">
              {sig.symbol}
            </span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                sig.direction === "bullish"
                  ? "bg-positive/15 text-positive"
                  : "bg-negative/15 text-negative"
              }`}
            >
              {sig.direction === "bullish" ? "\u2191" : "\u2193"}{" "}
              {sig.label}
            </span>
            <span className="text-[11px] text-gray-600 ml-auto font-mono shrink-0">
              {timeAgo(sig.firedAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

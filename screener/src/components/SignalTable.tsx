"use client";

import { useState } from "react";
import { Signal } from "@/lib/signals";

interface Props {
  signals: Signal[];
  onSelectAsset: (symbol: string) => void;
}

type SortKey = "symbol" | "type" | "direction" | "firedAt";

export default function SignalTable({ signals, onSelectAsset }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>("firedAt");
  const [sortAsc, setSortAsc] = useState(false);

  const sorted = [...signals].sort((a, b) => {
    const mul = sortAsc ? 1 : -1;
    if (sortKey === "firedAt") return (a.firedAt - b.firedAt) * mul;
    return String(a[sortKey]).localeCompare(String(b[sortKey])) * mul;
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else {
      setSortKey(key);
      setSortAsc(false);
    }
  };

  const headers: { key: SortKey; label: string }[] = [
    { key: "symbol", label: "Asset" },
    { key: "type", label: "Signal" },
    { key: "direction", label: "Direction" },
    { key: "firedAt", label: "Time" },
  ];

  if (!signals.length) {
    return (
      <div className="text-center py-8 text-gray-600 text-sm">
        No active signals
      </div>
    );
  }

  return (
    <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 uppercase tracking-wider border-b border-white/5">
            {headers.map((h) => (
              <th
                key={h.key}
                className="py-2 px-3 cursor-pointer hover:text-gray-300 transition-colors"
                onClick={() => handleSort(h.key)}
              >
                {h.label}
                {sortKey === h.key && (
                  <span className="ml-1">{sortAsc ? "\u25B2" : "\u25BC"}</span>
                )}
              </th>
            ))}
            <th className="py-2 px-3">Value</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((sig, i) => (
            <tr
              key={`${sig.symbol}-${sig.type}-${i}`}
              className="border-b border-white/3 hover:bg-white/3 cursor-pointer transition-colors"
              onClick={() => onSelectAsset(sig.symbol)}
            >
              <td className="py-2.5 px-3 font-semibold text-white">
                {sig.symbol}
              </td>
              <td className="py-2.5 px-3 text-gray-300">{sig.label}</td>
              <td className="py-2.5 px-3">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    sig.direction === "bullish"
                      ? "bg-positive/15 text-positive"
                      : "bg-negative/15 text-negative"
                  }`}
                >
                  {sig.direction}
                </span>
              </td>
              <td className="py-2.5 px-3 font-mono text-xs text-gray-500">
                {new Date(sig.firedAt).toLocaleTimeString()}
              </td>
              <td className="py-2.5 px-3 font-mono text-xs text-gray-400">
                {typeof sig.value === "number" ? sig.value.toFixed(4) : "--"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

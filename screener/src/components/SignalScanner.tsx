"use client";

import { useEffect, useState } from "react";
import { Signal } from "@/lib/signals";
import SignalFeed from "./SignalFeed";
import SignalTable from "./SignalTable";

interface Props {
  onSelectAsset: (symbol: string) => void;
}

export default function SignalScanner({ onSelectAsset }: Props) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [view, setView] = useState<"feed" | "table">("feed");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSignals = () =>
      fetch("/api/signals")
        .then((r) => r.json())
        .then((data: Signal[]) => {
          if (Array.isArray(data)) setSignals(data);
          setLoading(false);
        })
        .catch(() => setLoading(false));

    fetchSignals();
    const interval = setInterval(fetchSignals, 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="bg-surface/50 rounded-xl border border-white/5 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-positive animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">
            Signal Scanner
          </span>
          <span className="text-[10px] font-mono text-gray-600 bg-gray-800/50 px-1.5 py-0.5 rounded">
            {signals.length}
          </span>
        </div>
        <div className="flex items-center gap-1 bg-surface rounded-lg p-0.5">
          <button
            onClick={() => setView("feed")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              view === "feed"
                ? "bg-white/10 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Feed
          </button>
          <button
            onClick={() => setView("table")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
              view === "table"
                ? "bg-white/10 text-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Table
          </button>
        </div>
      </div>
      <div className="p-3">
        {loading ? (
          <div className="text-center py-8 text-gray-600 text-sm">
            Scanning for signals...
          </div>
        ) : view === "feed" ? (
          <SignalFeed signals={signals} onSelectAsset={onSelectAsset} />
        ) : (
          <SignalTable signals={signals} onSelectAsset={onSelectAsset} />
        )}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Signal } from "@/lib/signals";
import SignalFeed from "./SignalFeed";
import SignalTable from "./SignalTable";

interface Props {
  onSelectAsset: (symbol: string) => void;
  allowedSymbols: Set<string> | null; // null = not loaded yet, show all
}

export default function SignalScanner({ onSelectAsset, allowedSymbols }: Props) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [view, setView] = useState<"feed" | "table">("feed");
  const [loading, setLoading] = useState(true);

  const visibleSignals =
    allowedSymbols === null
      ? signals
      : signals.filter((s) => allowedSymbols.has(s.symbol));

  useEffect(() => {
    // Check r.ok before parsing — previously a 5xx response would
    // .then() into the error payload (a {error: ...} object) and the
    // Array.isArray guard would just leave the UI empty, indistinguish-
    // able from "no signals fired". Now a non-OK leaves the last good
    // signals visible and the page-level banner already signals the
    // backend issue to the user.
    const fetchSignals = () =>
      fetch("/api/signals")
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
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
            {visibleSignals.length}
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
          <SignalFeed signals={visibleSignals} onSelectAsset={onSelectAsset} />
        ) : (
          <SignalTable signals={visibleSignals} onSelectAsset={onSelectAsset} />
        )}
      </div>
    </div>
  );
}

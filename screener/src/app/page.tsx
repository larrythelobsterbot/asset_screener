"use client";

import { useState } from "react";
import MacroBar from "@/components/MacroBar";
import TimeframeToggle, { Timeframe } from "@/components/TimeframeToggle";
import Heatmap from "@/components/Heatmap";
import SignalScanner from "@/components/SignalScanner";
import AssetDetailModal from "@/components/AssetDetailModal";

export default function Home() {
  const [timeframe, setTimeframe] = useState<Timeframe>("24h");
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);

  return (
    <div className="min-h-screen flex flex-col">
      <MacroBar />

      <div className="flex items-center justify-between px-6 py-4">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-white">Asset</span>{" "}
          <span className="text-gray-500">Screener</span>
        </h1>
        <TimeframeToggle selected={timeframe} onChange={setTimeframe} />
      </div>

      <Heatmap timeframe={timeframe} onSelectAsset={setSelectedAsset} />

      <div className="px-4 pb-6 mt-2">
        <SignalScanner onSelectAsset={setSelectedAsset} />
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

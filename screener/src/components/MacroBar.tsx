"use client";

import { useEffect, useState } from "react";
import { MacroData } from "@/lib/types";

export default function MacroBar() {
  const [macros, setMacros] = useState<MacroData[]>([]);

  useEffect(() => {
    const fetch_ = () =>
      fetch("/api/macro")
        .then((r) => r.json())
        .then(setMacros)
        .catch(() => {});
    fetch_();
    const interval = setInterval(fetch_, 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center gap-6 px-6 py-3 bg-surface/80 backdrop-blur border-b border-white/5 overflow-x-auto">
      <span className="text-xs text-gray-500 uppercase tracking-widest font-medium shrink-0">
        Macro
      </span>
      {macros.map((m) => (
        <div key={m.symbol} className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-400">{m.label}</span>
          {m.value !== null ? (
            <>
              <span className="font-mono text-sm text-white">
                {m.value.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              {m.change !== null && (
                <span
                  className={`font-mono text-xs ${
                    m.change >= 0 ? "text-positive" : "text-negative"
                  }`}
                >
                  {m.change >= 0 ? "+" : ""}
                  {m.change.toFixed(2)}%
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-gray-600">--</span>
          )}
          {m.source === "static" && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 uppercase">
              delayed
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

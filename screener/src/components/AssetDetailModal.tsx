"use client";

import { useEffect, useState, useCallback } from "react";
import { HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP, ASSET_DESCRIPTIONS, ASSET_HOLDINGS, SECTORS } from "@/config/sectors";

// Reverse lookup: bare ticker → builder perp info (searches all dexes)
const BUILDER_TICKER_INFO: Record<string, { sector: string; label: string }> = {};
for (const [key, info] of Object.entries(HL_BUILDER_PERP_MAP)) {
  const ticker = key.split(":")[1];
  if (ticker && !(ticker in BUILDER_TICKER_INFO)) {
    BUILDER_TICKER_INFO[ticker] = info;
  }
}
import PriceChart from "./PriceChart";

interface AssetDetail {
  symbol: string;
  candles: Array<{
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  indicators: {
    rsi: (number | null)[];
    macd: { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] };
    ema13: (number | null)[];
    ema25: (number | null)[];
    ema32: (number | null)[];
    ma100: (number | null)[];
    ma300: (number | null)[];
    ema200: (number | null)[];
  };
  signals: Array<{
    type: string;
    direction: string;
    label: string;
    value: number;
  }>;
  stats: {
    price: number;
    oraclePrice: number;
    fundingRate: number;
    openInterest: number;
    volume24h: number;
  } | null;
}

interface Props {
  symbol: string;
  onClose: () => void;
}

export default function AssetDetailModal({ symbol, onClose }: Props) {
  const [data, setData] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [holdingsOpen, setHoldingsOpen] = useState(false);

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/asset/${symbol}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${symbol}`);
        return r.json();
      })
      .then((d: AssetDetail) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [symbol]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const perpMapping = HL_PERP_SECTOR_MAP[symbol];
  const builderMapping = BUILDER_TICKER_INFO[symbol];
  const mapping = perpMapping || builderMapping;
  const sectorColor = mapping ? SECTORS[mapping.sector as keyof typeof SECTORS]?.color || "#64748B" : "#64748B";
  const sectorLabel = mapping ? SECTORS[mapping.sector as keyof typeof SECTORS]?.label || mapping.sector : "Unknown";
  const description = ASSET_DESCRIPTIONS[symbol] ?? null;
  const holdings = ASSET_HOLDINGS[symbol] ?? null;

  const lastRsi = data?.indicators.rsi
    ? data.indicators.rsi.filter((v) => v !== null).pop()
    : null;
  const lastMacd = data?.indicators.macd.macd
    ? data.indicators.macd.macd.filter((v) => v !== null).pop()
    : null;
  const lastSignal = data?.indicators.macd.signal
    ? data.indicators.macd.signal.filter((v) => v !== null).pop()
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        className="relative bg-[#0D1117] border border-white/10 rounded-2xl max-w-[920px] w-full max-h-[90vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/5">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold text-white">{symbol}</span>
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wider"
                style={{
                  backgroundColor: `${sectorColor}20`,
                  color: sectorColor,
                }}
              >
                {sectorLabel}
              </span>
              {mapping && (
                <span className="text-sm text-gray-400">{mapping.label}</span>
              )}
            </div>
            {description && (
              <p className="text-xs text-gray-500 max-w-[680px] leading-relaxed">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors text-xl leading-none p-1"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="p-5">
          {loading && (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center gap-3 py-20">
              <span className="text-red-400 text-sm">{error}</span>
              <button
                onClick={fetchData}
                className="text-xs text-gray-400 hover:text-white border border-white/10 px-3 py-1.5 rounded-lg transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {data && !loading && !error && (
            <>
              {/* Price + Stats Row */}
              <div className="flex items-baseline gap-4 mb-5">
                <span className="text-3xl font-mono font-bold text-white">
                  $
                  {data.stats
                    ? data.stats.price < 1
                      ? data.stats.price.toPrecision(4)
                      : data.stats.price.toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })
                    : "--"}
                </span>
              </div>

              {/* Chart */}
              <PriceChart candles={data.candles} indicators={data.indicators} />

              {/* Stats Grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
                {/* RSI */}
                <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                    RSI (14)
                  </span>
                  <div
                    className={`font-mono text-lg mt-1 ${
                      lastRsi !== null && lastRsi !== undefined
                        ? lastRsi > 70
                          ? "text-negative"
                          : lastRsi < 30
                          ? "text-positive"
                          : "text-white"
                        : "text-gray-600"
                    }`}
                  >
                    {lastRsi !== null && lastRsi !== undefined
                      ? lastRsi.toFixed(1)
                      : "--"}
                  </div>
                  {lastRsi !== null && lastRsi !== undefined && (
                    <div className="w-full h-1.5 bg-gray-800 rounded-full mt-2 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${lastRsi}%`,
                          backgroundColor:
                            lastRsi > 70
                              ? "#EF4444"
                              : lastRsi < 30
                              ? "#22C55E"
                              : "#6B7280",
                        }}
                      />
                    </div>
                  )}
                </div>

                {/* MACD */}
                <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                    MACD
                  </span>
                  <div
                    className={`font-mono text-lg mt-1 ${
                      lastMacd !== null && lastMacd !== undefined
                        ? lastMacd >= 0
                          ? "text-positive"
                          : "text-negative"
                        : "text-gray-600"
                    }`}
                  >
                    {lastMacd !== null && lastMacd !== undefined
                      ? lastMacd.toFixed(4)
                      : "--"}
                  </div>
                  <span className="text-[10px] text-gray-600 font-mono">
                    Signal:{" "}
                    {lastSignal !== null && lastSignal !== undefined
                      ? lastSignal.toFixed(4)
                      : "--"}
                  </span>
                </div>

                {/* Volume */}
                <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                    24h Volume
                  </span>
                  <div className="font-mono text-lg mt-1 text-white">
                    {data.stats
                      ? `$${(data.stats.volume24h / 1_000_000).toFixed(1)}M`
                      : "--"}
                  </div>
                </div>

                {/* Funding Rate (perps only) */}
                {data.stats && (
                  <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Funding Rate
                    </span>
                    <div
                      className={`font-mono text-lg mt-1 ${
                        data.stats.fundingRate > 0
                          ? "text-positive"
                          : data.stats.fundingRate < 0
                          ? "text-negative"
                          : "text-white"
                      }`}
                    >
                      {(data.stats.fundingRate * 100).toFixed(4)}%
                    </div>
                  </div>
                )}
              </div>

              {/* Perp-specific stats */}
              {data.stats && (
                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Open Interest
                    </span>
                    <div className="font-mono text-sm mt-1 text-white">
                      ${(data.stats.openInterest / 1_000_000).toFixed(2)}M
                    </div>
                  </div>
                  <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Mark Price
                    </span>
                    <div className="font-mono text-sm mt-1 text-white">
                      ${data.stats.price.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                  </div>
                  <div className="bg-surface/50 rounded-lg p-3 border border-white/5">
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                      Oracle Price
                    </span>
                    <div className="font-mono text-sm mt-1 text-white">
                      ${data.stats.oraclePrice.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* Active Signals */}
              {data.signals.length > 0 && (
                <div className="mt-5">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wider">
                    Active Signals
                  </span>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {data.signals.map((sig, i) => (
                      <span
                        key={i}
                        className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                          sig.direction === "bullish"
                            ? "bg-positive/15 text-positive"
                            : "bg-negative/15 text-negative"
                        }`}
                      >
                        {sig.direction === "bullish" ? "\u2191" : "\u2193"}{" "}
                        {sig.label}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Holdings */}
              {holdings && (
                <div className="mt-5 border border-white/5 rounded-xl overflow-hidden">
                  <button
                    onClick={() => setHoldingsOpen((o) => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
                  >
                    <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">
                      Top Holdings ({holdings.length})
                    </span>
                    <span className="text-gray-600 text-xs">{holdingsOpen ? "▲" : "▼"}</span>
                  </button>
                  {holdingsOpen && (
                    <div className="px-4 pb-4 grid grid-cols-2 gap-x-6 gap-y-1.5">
                      {holdings.map((h, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs text-gray-400">
                          <span className="text-gray-700 font-mono w-4 text-right shrink-0">{i + 1}</span>
                          <span>{h}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

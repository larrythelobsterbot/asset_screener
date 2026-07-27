import type { AssetData } from "@/lib/types";
import type { FilterTimeframe } from "@/lib/useFilters";

export type HeatmapColorMetric = "price" | "oi-change" | "funding";
export type HeatmapSizeMetric = "volume" | "oi" | "equal";

export interface HeatmapColorValue {
  /** Signed divergent tone. Positive renders green, negative renders red. */
  tone: number | null;
  display: string;
  tooltip: string;
}

function selectedChange(asset: AssetData, timeframe: FilterTimeframe): number | null {
  if (timeframe === "1h") return asset.change1h;
  if (timeframe === "4h") return asset.change4h;
  if (timeframe === "7d") return asset.change7d;
  return asset.change24h;
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.abs(value) < 0.005 ? 0 : value;
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}%`;
}

function finiteOrNull(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function getHeatmapColorValue(
  asset: AssetData,
  metric: HeatmapColorMetric,
  timeframe: FilterTimeframe,
): HeatmapColorValue {
  if (metric === "price") {
    const change = finiteOrNull(selectedChange(asset, timeframe));
    return {
      tone: change,
      display: formatPct(change),
      tooltip: `${timeframe} price change`,
    };
  }

  if (metric === "oi-change") {
    const change = finiteOrNull(asset.oiChange24hPct);
    return {
      tone: change,
      display: formatPct(change),
      tooltip: "24h open-interest change",
    };
  }

  const funding = asset.fundingAvg24h;
  const apr = funding == null || !Number.isFinite(funding)
    ? null
    : Math.round(funding * 24 * 365 * 100 * 100) / 100;
  return {
    // Positive funding means longs pay shorts, so positive APR is rendered
    // red (crowded longs) and negative APR green (crowded shorts).
    tone: apr == null ? null : -apr,
    display: formatPct(apr),
    tooltip: "24h mean funding APR",
  };
}

export function getHeatmapWeight(asset: AssetData, metric: HeatmapSizeMetric): number {
  if (metric === "equal") return 1;
  const raw = metric === "oi" ? asset.oiUsd ?? 0 : asset.volume24h;
  // Log scaling preserves differences without allowing the largest market to
  // consume the canvas. A small floor keeps missing-OI spot assets visible.
  const safeRaw = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  return Math.max(0.05, Math.log10(safeRaw / 1_000_000 + 1));
}

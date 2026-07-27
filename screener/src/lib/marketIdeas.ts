import type { Signal, SignalDirection, SignalFamily } from "@/lib/signals";
import type { AssetData } from "@/lib/types";
import type { FilterTimeframe } from "@/lib/useFilters";

export type IdeaDirection = SignalDirection | "conflict" | "neutral";
export type IdeaReasonKind = "signal" | "price" | "flow" | "funding" | "turnover";

export interface IdeaReason {
  kind: IdeaReasonKind;
  label: string;
  tone: "bullish" | "bearish" | "warn" | "neutral";
}

export interface MarketIdea {
  asset: AssetData;
  signals: Signal[];
  direction: IdeaDirection;
  familyCount: number;
  signalCount: number;
  latestSignalAt: number | null;
  anomalyCount: number;
  reasons: IdeaReason[];
}

export interface MarketIdeaFilters {
  direction: "any" | IdeaDirection;
  evidence: "all" | "actionable" | "signals" | "anomalies";
  maxSignalAgeHours: number | null;
}

export const DEFAULT_IDEA_FILTERS: MarketIdeaFilters = {
  direction: "any",
  evidence: "actionable",
  maxSignalAgeHours: null,
};

function changeFor(asset: AssetData, timeframe: FilterTimeframe): number | null {
  if (timeframe === "1h") return asset.change1h;
  if (timeframe === "4h") return asset.change4h;
  if (timeframe === "7d") return asset.change7d;
  return asset.change24h;
}

function directionOf(signals: Signal[]): IdeaDirection {
  let bullish = false;
  let bearish = false;
  for (const signal of signals) {
    if (signal.direction === "bullish") bullish = true;
    if (signal.direction === "bearish") bearish = true;
  }
  if (bullish && bearish) return "conflict";
  if (bullish) return "bullish";
  if (bearish) return "bearish";
  return "neutral";
}

function signalReason(signal: Signal): IdeaReason {
  const timeframe = signal.timeframe === "cross"
    ? "Cross-market"
    : signal.timeframe ?? "Signal";
  return {
    kind: "signal",
    label: `${timeframe} ${signal.label}`,
    tone: signal.direction,
  };
}

function anomalyReasons(asset: AssetData, timeframe: FilterTimeframe): IdeaReason[] {
  const reasons: IdeaReason[] = [];
  const oiChange = asset.oiChange24hPct;
  if (oiChange !== null && Number.isFinite(oiChange) && Math.abs(oiChange) >= 5) {
    reasons.push({
      kind: "flow",
      label: `OI ${oiChange > 0 ? "expanding" : "contracting"} ${oiChange > 0 ? "+" : ""}${oiChange.toFixed(1)}%`,
      tone: oiChange > 0 ? "bullish" : "bearish",
    });
  }

  const funding = asset.fundingAvg24h;
  if (funding !== null && Number.isFinite(funding)) {
    const fundingApr = funding * 24 * 365 * 100;
    if (Math.abs(fundingApr) >= 25) {
      reasons.push({
        kind: "funding",
        label: `${fundingApr > 0 ? "Longs" : "Shorts"} paying ${Math.abs(fundingApr).toFixed(0)}% APR`,
        tone: "warn",
      });
    }
  }

  const change = changeFor(asset, timeframe);
  if (change !== null && Number.isFinite(change) && Math.abs(change) >= 2) {
    reasons.push({
      kind: "price",
      label: `${timeframe} price ${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
      tone: change > 0 ? "bullish" : "bearish",
    });
  }

  const turnover = asset.volOiRatio;
  if (turnover !== null && Number.isFinite(turnover)) {
    if (turnover >= 2) {
      reasons.push({
        kind: "turnover",
        label: `Hot turnover ${turnover.toFixed(1)}×`,
        tone: "warn",
      });
    } else if (turnover <= 0.5) {
      reasons.push({
        kind: "turnover",
        label: `Parked positioning ${turnover.toFixed(1)}×`,
        tone: "neutral",
      });
    }
  }
  return reasons;
}

export function buildMarketIdeas(
  assets: AssetData[],
  signals: Signal[],
  timeframe: FilterTimeframe,
): MarketIdea[] {
  const signalsBySymbol = new Map<string, Signal[]>();
  for (const signal of signals) {
    if (!Number.isFinite(signal.firedAt)) continue;
    const grouped = signalsBySymbol.get(signal.symbol);
    if (grouped) grouped.push(signal);
    else signalsBySymbol.set(signal.symbol, [signal]);
  }

  const ideas = assets.map((asset): MarketIdea => {
    const assetSignals = [...(signalsBySymbol.get(asset.symbol) ?? [])]
      .sort((a, b) => b.firedAt - a.firedAt);
    const families = new Set<SignalFamily>(assetSignals.map((signal) => signal.family));
    const anomalies = anomalyReasons(asset, timeframe);
    return {
      asset,
      signals: assetSignals,
      direction: directionOf(assetSignals),
      familyCount: families.size,
      signalCount: assetSignals.length,
      latestSignalAt: assetSignals[0]?.firedAt ?? null,
      anomalyCount: anomalies.length,
      reasons: [...assetSignals.map(signalReason), ...anomalies],
    };
  });

  ideas.sort((a, b) => {
    const signalDelta = Number(b.signalCount > 0) - Number(a.signalCount > 0);
    if (signalDelta !== 0) return signalDelta;
    if (b.familyCount !== a.familyCount) return b.familyCount - a.familyCount;
    if ((b.latestSignalAt ?? 0) !== (a.latestSignalAt ?? 0)) {
      return (b.latestSignalAt ?? 0) - (a.latestSignalAt ?? 0);
    }
    if (b.anomalyCount !== a.anomalyCount) return b.anomalyCount - a.anomalyCount;
    return b.asset.volume24h - a.asset.volume24h;
  });
  return ideas;
}

export function filterMarketIdeas(
  ideas: MarketIdea[],
  filters: MarketIdeaFilters,
  now: number = Date.now(),
): MarketIdea[] {
  return ideas.filter((idea) => {
    if (filters.direction !== "any" && idea.direction !== filters.direction) return false;
    if (filters.evidence === "actionable" && idea.signalCount === 0 && idea.anomalyCount < 2) return false;
    if (filters.evidence === "signals" && idea.signalCount === 0) return false;
    if (filters.evidence === "anomalies" && idea.anomalyCount === 0) return false;
    if (filters.maxSignalAgeHours !== null) {
      if (idea.latestSignalAt === null) return false;
      const ageMs = now - idea.latestSignalAt;
      if (ageMs < 0 || ageMs > filters.maxSignalAgeHours * 60 * 60_000) return false;
    }
    return true;
  });
}

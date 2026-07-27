"use client";

import { useState, useEffect } from "react";
import { SECTORS } from "@/config/sectors";
import { AssetData } from "@/lib/types";
import { readStorage, writeStorage } from "@/lib/safeStorage";

export interface FilterState {
  minVolume: number | null; // null = Any
  minOIUsd: number | null;  // null = Any
  sectors: AssetData["sector"][];
  sources: AssetData["source"][];
  moveDirection: "any" | "up" | "down";
  minAbsMovePct: number | null;
  oiTrend: "any" | "rising" | "falling";
  minAbsOIChange24hPct: number | null;
  fundingBias: "any" | "positive" | "negative";
  minAbsFundingAprPct: number | null;
  minVolOiRatio: number | null;
  maxVolOiRatio: number | null;
}

export const DEFAULT_FILTERS: FilterState = {
  minVolume: null,
  minOIUsd: null,
  sectors: [],
  sources: [],
  moveDirection: "any",
  minAbsMovePct: null,
  oiTrend: "any",
  minAbsOIChange24hPct: null,
  fundingBias: "any",
  minAbsFundingAprPct: null,
  minVolOiRatio: null,
  maxVolOiRatio: null,
};

export interface FilterPreset {
  id: string;
  label: string;
  description: string;
  filters: FilterState;
}

export const FILTER_PRESETS: FilterPreset[] = [
  {
    id: "liquid-perps",
    label: "Liquid perps",
    description: "At least $10M volume and $5M open interest",
    filters: {
      ...DEFAULT_FILTERS,
      sources: ["hyperliquid"],
      minVolume: 10_000_000,
      minOIUsd: 5_000_000,
    },
  },
  {
    id: "oi-expansion",
    label: "OI expansion",
    description: "Liquid perps with at least 5% 24h OI growth",
    filters: {
      ...DEFAULT_FILTERS,
      sources: ["hyperliquid"],
      minVolume: 1_000_000,
      minOIUsd: 1_000_000,
      oiTrend: "rising",
      minAbsOIChange24hPct: 5,
    },
  },
  {
    id: "funding-extremes",
    label: "Funding extremes",
    description: "Perps with at least 25% absolute average funding APR",
    filters: {
      ...DEFAULT_FILTERS,
      sources: ["hyperliquid"],
      minVolume: 1_000_000,
      minAbsFundingAprPct: 25,
    },
  },
  {
    id: "hot-turnover",
    label: "Hot turnover",
    description: "Perps trading at least twice their open interest per day",
    filters: {
      ...DEFAULT_FILTERS,
      sources: ["hyperliquid"],
      minVolume: 1_000_000,
      minVolOiRatio: 2,
    },
  },
];
const STORAGE_KEY = "asset-screener-filters";
const STORAGE_VERSION = 1;

export type FilterTimeframe = "1h" | "4h" | "24h" | "7d";
export type FilterKey = keyof FilterState;

export interface ActiveFilter {
  key: FilterKey;
  label: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function uniqueAllowed<T extends string>(value: unknown, allowed: ReadonlySet<string>): T[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (entry): entry is T => typeof entry === "string" && allowed.has(entry),
  ))];
}

function defaultFilters(): FilterState {
  return { ...DEFAULT_FILTERS, sectors: [], sources: [] };
}

/** Parse and normalize persisted UI filters without trusting localStorage data. */
export function parseStoredFilters(raw: string | null): FilterState {
  if (!raw) return defaultFilters();

  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return defaultFilters();

    let candidate: UnknownRecord;
    if ("version" in parsed) {
      if (parsed.version !== STORAGE_VERSION) return defaultFilters();
      const storedFilters = asRecord(parsed.filters);
      if (!storedFilters) return defaultFilters();
      candidate = storedFilters;
    } else {
      // Legacy volume used the correct unit. Legacy `minOI` was evaluated in
      // coin units despite its USD label, so it is intentionally reset.
      candidate = parsed;
    }

    const filters: FilterState = {
      minVolume: nonNegativeNumber(candidate.minVolume),
      minOIUsd: nonNegativeNumber(candidate.minOIUsd),
      sectors: uniqueAllowed<AssetData["sector"]>(candidate.sectors, new Set(Object.keys(SECTORS))),
      sources: uniqueAllowed<AssetData["source"]>(candidate.sources, new Set(["hyperliquid", "coingecko"])),
      moveDirection:
        candidate.moveDirection === "up" || candidate.moveDirection === "down"
          ? candidate.moveDirection
          : "any",
      minAbsMovePct: nonNegativeNumber(candidate.minAbsMovePct),
      oiTrend:
        candidate.oiTrend === "rising" || candidate.oiTrend === "falling"
          ? candidate.oiTrend
          : "any",
      minAbsOIChange24hPct: nonNegativeNumber(candidate.minAbsOIChange24hPct),
      fundingBias:
        candidate.fundingBias === "positive" || candidate.fundingBias === "negative"
          ? candidate.fundingBias
          : "any",
      minAbsFundingAprPct: nonNegativeNumber(candidate.minAbsFundingAprPct),
      minVolOiRatio: nonNegativeNumber(candidate.minVolOiRatio),
      maxVolOiRatio: nonNegativeNumber(candidate.maxVolOiRatio),
    };

    if (
      filters.minVolOiRatio !== null &&
      filters.maxVolOiRatio !== null &&
      filters.minVolOiRatio > filters.maxVolOiRatio
    ) {
      filters.minVolOiRatio = null;
      filters.maxVolOiRatio = null;
    }

    return filters;
  } catch {
    return defaultFilters();
  }
}

function compactUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${value / 1_000_000_000}B`;
  if (value >= 1_000_000) return `$${value / 1_000_000}M`;
  if (value >= 1_000) return `$${value / 1_000}K`;
  return `$${value}`;
}

export function getActiveFilters(
  filters: FilterState,
  timeframe: FilterTimeframe = "24h",
): ActiveFilter[] {
  const active: ActiveFilter[] = [];
  if (filters.sectors.length > 0) {
    active.push({ key: "sectors", label: `Sectors: ${filters.sectors.length}` });
  }
  if (filters.sources.length > 0) {
    active.push({ key: "sources", label: `Sources: ${filters.sources.length}` });
  }
  if (filters.minVolume !== null) {
    active.push({ key: "minVolume", label: `Volume ≥ ${compactUsd(filters.minVolume)}` });
  }
  if (filters.minOIUsd !== null) {
    active.push({ key: "minOIUsd", label: `OI ≥ ${compactUsd(filters.minOIUsd)}` });
  }
  if (filters.moveDirection !== "any") {
    active.push({
      key: "moveDirection",
      label: `${timeframe} ${filters.moveDirection === "up" ? "gainers" : "losers"}`,
    });
  }
  if (filters.minAbsMovePct !== null) {
    active.push({ key: "minAbsMovePct", label: `${timeframe} move ≥ ${filters.minAbsMovePct}%` });
  }
  if (filters.oiTrend !== "any") {
    active.push({ key: "oiTrend", label: `OI ${filters.oiTrend}` });
  }
  if (filters.minAbsOIChange24hPct !== null) {
    active.push({
      key: "minAbsOIChange24hPct",
      label: `OI move ≥ ${filters.minAbsOIChange24hPct}%`,
    });
  }
  if (filters.fundingBias !== "any") {
    active.push({ key: "fundingBias", label: `${filters.fundingBias} funding` });
  }
  if (filters.minAbsFundingAprPct !== null) {
    active.push({
      key: "minAbsFundingAprPct",
      label: `|Funding APR| ≥ ${filters.minAbsFundingAprPct}%`,
    });
  }
  if (filters.minVolOiRatio !== null) {
    active.push({ key: "minVolOiRatio", label: `Vol/OI ≥ ${filters.minVolOiRatio}×` });
  }
  if (filters.maxVolOiRatio !== null) {
    active.push({ key: "maxVolOiRatio", label: `Vol/OI ≤ ${filters.maxVolOiRatio}×` });
  }
  return active;
}

export function clearActiveFilter(filters: FilterState, key: FilterKey): FilterState {
  const defaultValue = DEFAULT_FILTERS[key];
  return {
    ...filters,
    [key]: Array.isArray(defaultValue) ? [...defaultValue] : defaultValue,
  };
}

function changeFor(asset: AssetData, timeframe: FilterTimeframe): number | null {
  if (timeframe === "1h") return asset.change1h;
  if (timeframe === "4h") return asset.change4h;
  if (timeframe === "7d") return asset.change7d;
  return asset.change24h;
}

/** Pure helper — exported so page.tsx can apply filter logic against the markets data */
export function passesFilters(
  asset: AssetData,
  filters: FilterState,
  timeframe: FilterTimeframe = "24h",
): boolean {
  if (filters.minVolume !== null) {
    if (!Number.isFinite(asset.volume24h) || asset.volume24h < filters.minVolume) return false;
  }
  // OI thresholds are dollar values. `openInterest` is denominated in each
  // market's native coin and cannot be compared across assets. Missing OI
  // fails an active threshold rather than silently letting spot assets pass.
  if (filters.minOIUsd !== null) {
    if (asset.oiUsd === null || !Number.isFinite(asset.oiUsd) || asset.oiUsd < filters.minOIUsd) {
      return false;
    }
  }
  if (filters.sectors.length > 0 && !filters.sectors.includes(asset.sector)) {
    return false;
  }
  if (filters.sources.length > 0 && !filters.sources.includes(asset.source)) {
    return false;
  }
  if (filters.moveDirection !== "any" || filters.minAbsMovePct !== null) {
    const change = changeFor(asset, timeframe);
    if (change === null || !Number.isFinite(change)) return false;
    if (filters.moveDirection === "up" && change <= 0) return false;
    if (filters.moveDirection === "down" && change >= 0) return false;
    if (filters.minAbsMovePct !== null && Math.abs(change) < filters.minAbsMovePct) {
      return false;
    }
  }
  if (filters.oiTrend !== "any" || filters.minAbsOIChange24hPct !== null) {
    const change = asset.oiChange24hPct;
    if (change === null || !Number.isFinite(change)) return false;
    if (filters.oiTrend === "rising" && change <= 0) return false;
    if (filters.oiTrend === "falling" && change >= 0) return false;
    if (
      filters.minAbsOIChange24hPct !== null &&
      Math.abs(change) < filters.minAbsOIChange24hPct
    ) {
      return false;
    }
  }
  if (filters.fundingBias !== "any" || filters.minAbsFundingAprPct !== null) {
    const funding = asset.fundingAvg24h;
    if (funding === null || !Number.isFinite(funding)) return false;
    if (filters.fundingBias === "positive" && funding <= 0) return false;
    if (filters.fundingBias === "negative" && funding >= 0) return false;
    const aprPct = Math.abs(funding * 24 * 365 * 100);
    if (filters.minAbsFundingAprPct !== null && aprPct < filters.minAbsFundingAprPct) {
      return false;
    }
  }
  if (filters.minVolOiRatio !== null || filters.maxVolOiRatio !== null) {
    const ratio = asset.volOiRatio;
    if (ratio === null || !Number.isFinite(ratio)) return false;
    if (filters.minVolOiRatio !== null && ratio < filters.minVolOiRatio) return false;
    if (filters.maxVolOiRatio !== null && ratio > filters.maxVolOiRatio) return false;
  }
  return true;
}

export function useFilters() {
  const [filters, setFiltersState] = useState<FilterState>(DEFAULT_FILTERS);

  // Load from localStorage on mount — SSR guard required: Next.js may run this server-side
  useEffect(() => {
    if (typeof window === "undefined") return;
    setFiltersState(parseStoredFilters(readStorage(() => window.localStorage, STORAGE_KEY)));
  }, []);

  function setFilter(patch: Partial<FilterState>) {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") {
        writeStorage(
          () => window.localStorage,
          STORAGE_KEY,
          JSON.stringify({ version: STORAGE_VERSION, filters: next }),
        );
      }
      return next;
    });
  }

  function clearFilters() {
    setFiltersState(DEFAULT_FILTERS);
    if (typeof window !== "undefined") {
      writeStorage(
        () => window.localStorage,
        STORAGE_KEY,
        JSON.stringify({ version: STORAGE_VERSION, filters: DEFAULT_FILTERS }),
      );
    }
  }

  const activeCount = getActiveFilters(filters).length;

  return { filters, setFilter, clearFilters, activeCount };
}

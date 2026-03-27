"use client";

import { useState, useEffect } from "react";
import { AssetData } from "@/lib/types";

export interface FilterState {
  minVolume: number | null; // null = Any
  minOI: number | null;     // null = Any
}

const DEFAULT_FILTERS: FilterState = { minVolume: null, minOI: null };
const STORAGE_KEY = "asset-screener-filters";

/** Pure helper — exported so Heatmap and page.tsx share the same logic */
export function passesFilters(asset: AssetData, filters: FilterState): boolean {
  if (filters.minVolume !== null && asset.volume24h < filters.minVolume) {
    return false;
  }
  // openInterest is null for CoinGecko/spot assets — they always pass the OI filter
  if (
    filters.minOI !== null &&
    asset.openInterest !== null &&
    asset.openInterest < filters.minOI
  ) {
    return false;
  }
  return true;
}

export function useFilters() {
  const [filters, setFiltersState] = useState<FilterState>(DEFAULT_FILTERS);

  // Load from localStorage on mount — SSR guard required: Next.js may run this server-side
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          setFiltersState({
            minVolume: typeof parsed.minVolume === "number" ? parsed.minVolume : null,
            minOI: typeof parsed.minOI === "number" ? parsed.minOI : null,
          });
        }
      }
    } catch {
      // ignore malformed stored data
    }
  }, []);

  function setFilter(patch: Partial<FilterState>) {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }

  function clearFilters() {
    setFiltersState(DEFAULT_FILTERS);
    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  const activeCount = [filters.minVolume, filters.minOI].filter(
    (v) => v !== null
  ).length;

  return { filters, setFilter, clearFilters, activeCount };
}

"use client";

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "asset-screener-watchlist";

function loadWatchlist(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveWatchlist(symbols: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...symbols]));
  } catch {
    // localStorage full or unavailable — silently fail
  }
}

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());

  useEffect(() => {
    setWatchlist(loadWatchlist());
  }, []);

  const toggle = useCallback((symbol: string) => {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      saveWatchlist(next);
      return next;
    });
  }, []);

  const isWatched = useCallback(
    (symbol: string) => watchlist.has(symbol),
    [watchlist]
  );

  return { watchlist, toggle, isWatched, count: watchlist.size };
}

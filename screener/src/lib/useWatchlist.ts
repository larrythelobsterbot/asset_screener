"use client";

import { useState, useEffect, useCallback } from "react";
import { readStorage, writeStorage } from "@/lib/safeStorage";
import { parseStoredStringSet, serializeStringSet } from "@/lib/stringSetStorage";

const STORAGE_KEY = "asset-screener-watchlist";

function loadWatchlist(): Set<string> {
  if (typeof window === "undefined") return new Set();
  return parseStoredStringSet(readStorage(() => window.localStorage, STORAGE_KEY));
}

function saveWatchlist(symbols: Set<string>) {
  if (typeof window === "undefined") return;
  writeStorage(() => window.localStorage, STORAGE_KEY, serializeStringSet(symbols));
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

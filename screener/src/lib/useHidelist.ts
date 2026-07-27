"use client";

import { useState, useEffect, useCallback } from "react";
import { readStorage, writeStorage } from "@/lib/safeStorage";
import { parseStoredStringSet, serializeStringSet } from "@/lib/stringSetStorage";

// Hide-list — opposite of useWatchlist. Tracks symbols the user has
// explicitly excluded from the heatmap/table. Persisted to localStorage
// so the choice survives reloads.
//
// Why a separate hook instead of overloading useWatchlist:
//   - The Watchlist is an "affirmative interest" list (show only these)
//   - The Hide-list is a "never bother me with these" list (show
//     everything EXCEPT these)
// They serve different intents and most users will only use one of the
// two. Keeping them separate avoids modal-state confusion.

const STORAGE_KEY = "asset-screener-hidelist";

function load(): Set<string> {
  if (typeof window === "undefined") return new Set();
  return parseStoredStringSet(readStorage(() => window.localStorage, STORAGE_KEY));
}

function save(symbols: Set<string>): void {
  if (typeof window === "undefined") return;
  writeStorage(() => window.localStorage, STORAGE_KEY, serializeStringSet(symbols));
}

export function useHidelist() {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  useEffect(() => {
    setHidden(load());
  }, []);

  const hide = useCallback((symbol: string) => {
    setHidden((prev) => {
      if (prev.has(symbol)) return prev;
      const next = new Set(prev);
      next.add(symbol);
      save(next);
      return next;
    });
  }, []);

  const unhide = useCallback((symbol: string) => {
    setHidden((prev) => {
      if (!prev.has(symbol)) return prev;
      const next = new Set(prev);
      next.delete(symbol);
      save(next);
      return next;
    });
  }, []);

  const toggle = useCallback((symbol: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      save(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    const empty = new Set<string>();
    setHidden(empty);
    save(empty);
  }, []);

  return { hidden, hide, unhide, toggle, clear, count: hidden.size };
}

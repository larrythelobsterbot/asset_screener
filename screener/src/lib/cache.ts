interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  // When a stale-while-revalidate refresh is inflight, the Promise is
  // parked here so concurrent callers await the same refresh instead of
  // triggering one per request. Undefined when no refresh is pending.
  refreshing?: Promise<T>;
}

class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      // Leave the entry in place for getStale() / getWithRefresh() to use.
      // Old behaviour deleted it; retaining it is safe because the TTL
      // check above still prevents stale reads via plain get().
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  getStale<T>(key: string): T | null {
    const entry = this.store.get(key);
    return entry ? (entry.data as T) : null;
  }

  // Stale-while-revalidate: returns fresh data if the TTL hasn't elapsed,
  // otherwise returns stale data immediately while kicking off a
  // background refresh that will repopulate the cache. If no value exists
  // at all, awaits the fetcher synchronously so the caller gets a result.
  //
  // `staleForMs` caps how long a stale value can be served before we
  // refuse to return it (and instead await the fetcher). Defaults to 5×
  // the TTL, which is a reasonable "keep the UI responsive but don't
  // serve days-old data if the source has been down for a long time".
  async getWithRefresh<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlMs: number,
    staleForMs: number = ttlMs * 5
  ): Promise<T> {
    const entry = this.store.get(key) as CacheEntry<T> | undefined;
    const now = Date.now();

    if (entry && now <= entry.expiresAt) {
      // Fresh hit — no refresh needed.
      return entry.data;
    }

    // Stale or absent. If an existing refresh is inflight, await that
    // instead of firing another one (single-flight).
    if (entry?.refreshing) {
      if (now - entry.expiresAt < staleForMs) {
        return entry.data; // stale is fine while refresh is pending
      }
      return entry.refreshing;
    }

    // Kick off a refresh.
    const refresh = fetcher()
      .then((data) => {
        this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
        return data;
      })
      .catch((err) => {
        // Clear the refreshing marker on failure so a later call can retry.
        const existing = this.store.get(key);
        if (existing) existing.refreshing = undefined;
        throw err;
      });

    if (entry && now - entry.expiresAt < staleForMs) {
      // Attach the inflight promise to the stale entry so concurrent
      // callers can single-flight, then serve stale immediately.
      entry.refreshing = refresh;
      return entry.data;
    }

    // No stale fallback available — await the fresh fetch.
    return refresh;
  }
}

export const cache = new TTLCache();

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  // When a stale-while-revalidate refresh is inflight, the Promise is
  // parked here so concurrent callers await the same refresh instead of
  // triggering one per request. Undefined when no refresh is pending.
  //
  // CRITICAL: this promise's rejection must NEVER propagate as an
  // unhandled rejection. The stale-serving path of getWithRefresh
  // attaches a swallowing `.catch()` before returning; if you change
  // that code path, keep the swallow.
  refreshing?: Promise<T>;
}

class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();
  // Tracks inflight fetches for COLD-miss keys so concurrent first-
  // request callers share one upstream call. Separate from the
  // CacheEntry.refreshing field which is for stale-with-data entries.
  private coldInflight = new Map<string, Promise<unknown>>();

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

    // Cold-miss single-flight: if there's NO entry at all but another
    // concurrent call already has a fetch running for this key, await
    // theirs. This closes a gap from before where the first N concurrent
    // cold callers each fired their own fetch.
    if (!entry) {
      const inflight = this.coldInflight.get(key) as Promise<T> | undefined;
      if (inflight) return inflight;
    }

    // Kick off a refresh. The `internal` chain mutates cache state and
    // catches errors so a background-only refresh CANNOT escape as an
    // unhandled rejection. The `external` chain re-exposes the error to
    // any caller that's awaiting it (i.e. the cold-fetch path that has
    // no stale data to serve).
    const internal: Promise<T> = fetcher().then(
      (data) => {
        this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
        this.coldInflight.delete(key);
        return data;
      },
      (err: unknown) => {
        // Clear the refreshing markers on failure so a later call can retry.
        const existing = this.store.get(key);
        if (existing) existing.refreshing = undefined;
        this.coldInflight.delete(key);
        // Re-throw so any caller awaiting the same promise (cold path)
        // sees the failure. The background-refresh path attaches an
        // additional swallow below so its rejection doesn't escape.
        throw err;
      }
    );

    if (entry && now - entry.expiresAt < staleForMs) {
      // Stale-serve path: park the inflight, return stale immediately.
      // The internal promise above already updates the cache on success
      // and clears `refreshing` on failure. We attach a swallow here so
      // the rejection — which no caller awaits — does not surface as
      // an `unhandledRejection` in the process.
      entry.refreshing = internal;
      internal.catch(() => { /* logged elsewhere; do not escape */ });
      return entry.data;
    }

    // No stale fallback available — caller awaits the fresh fetch.
    // Register the inflight so concurrent cold callers single-flight.
    this.coldInflight.set(key, internal as Promise<unknown>);
    return internal;
  }
}

export const cache = new TTLCache();

// Hypurrscan client — fetches active HYPE TWAP orders and computes the
// signed buy-pressure in dollars over a forward lookahead window.
//
// The "buy pressure" metric mirrors what hypurrscan.io/dashboard shows.
// Their dashboard fetches the same /twap/HYPE list we use here and
// computes pressure entirely client-side; we reproduce the formula
// server-side so we can poll it, persist time series, and alert on
// thresholds.
//
// Per-TWAP formula (sums across all active orders):
//   start_ms      = twap.time
//   duration_ms   = twap.action.twap.m × 60 × 1000     (m is minutes)
//   end_ms        = start_ms + duration_ms
//   size_base     = parseFloat(twap.action.twap.s)
//   value_usd     = size_base × current_HYPE_price
//   window_end    = now + lookahead_ms
//   eff_end       = min(end_ms, window_end)
//   ms_in_window  = max(0, eff_end - now)
//   pro_rata_usd  = (value_usd / duration_ms) × ms_in_window
//   sign          = +1 if twap.action.twap.b (buy) else −1
//   contribution  = sign × pro_rata_usd
//
// Skip the TWAP if `ended` is present (it terminated) or end_ms <= now
// (already complete).

const HYPURR_API = "https://api.hypurrscan.io";
const FETCH_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

// Raw shape returned by /twap/HYPE. Fields we don't use are typed
// loosely to avoid pinning ourselves to undocumented internals.
interface RawTwap {
  time: number;
  user: string;
  action: {
    type: string;
    twap: {
      a: number;            // asset id (10107 = HYPE spot at time of writing)
      b: boolean;           // buy = true, sell = false
      s: string;            // size in base units (HYPE)
      r: boolean;           // reduce-only flag (unused here)
      m: number;            // duration in minutes
      t: boolean;           // unknown flag (unused)
    };
  };
  hash: string;
  error: string | null;
  // Present if the TWAP terminated early (any non-null value means done).
  ended?: string;
}

let lastFetchTs = 0;
let lastFetchData: RawTwap[] = [];
let inflightFetch: Promise<RawTwap[]> | null = null;
let totalFetches = 0;
let totalErrors = 0;

async function fetchActiveTwaps(): Promise<RawTwap[]> {
  const now = Date.now();
  if (now - lastFetchTs < FETCH_TTL_MS && lastFetchData.length > 0) {
    return lastFetchData;
  }
  // Single-flight: if a fetch is already running, await it instead of
  // firing a duplicate. Multiple route handlers calling this at the
  // same time should hit one upstream request.
  if (inflightFetch) return inflightFetch;

  inflightFetch = (async (): Promise<RawTwap[]> => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      totalFetches += 1;
      const res = await fetch(`${HYPURR_API}/twap/HYPE`, {
        signal: controller.signal,
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        totalErrors += 1;
        throw new Error(`Hypurrscan ${res.status}`);
      }
      const data = (await res.json()) as RawTwap[];
      if (!Array.isArray(data)) {
        totalErrors += 1;
        throw new Error("Hypurrscan: unexpected response shape");
      }
      lastFetchData = data;
      lastFetchTs = Date.now();
      return data;
    } catch (err) {
      totalErrors += 1;
      // Serve last good payload on transient failure rather than blowing
      // the route. Stale values are better than no values for an
      // observability widget.
      if (lastFetchData.length > 0) return lastFetchData;
      throw err;
    } finally {
      clearTimeout(t);
      inflightFetch = null;
    }
  })();

  return inflightFetch;
}

export interface PressureResult {
  // Pressure summed in signed USD across the lookahead window. Positive
  // means net buy pressure, negative means net sell.
  pressure_1h_usd: number;
  pressure_24h_usd: number;
  // Number of TWAPs that contributed (started ≤ now, end > now).
  active_twap_count: number;
  // HYPE mid used for value conversion — informational only.
  hype_price: number;
  // When the upstream payload was fetched.
  source_ts: number;
}

// Pure function — exposed so the route + tests can call it without
// re-fetching. Caller supplies the current HYPE mid (from our WS) so
// the formula uses the same price the UI shows.
export function computePressureFromTwaps(
  twaps: RawTwap[],
  hypePrice: number,
  nowMs: number = Date.now()
): Omit<PressureResult, "hype_price" | "source_ts"> {
  let p1h = 0;
  let p24h = 0;
  let active = 0;
  const LOOKAHEAD_1H = 3_600_000;
  const LOOKAHEAD_24H = 86_400_000;

  for (const t of twaps) {
    if (t.ended) continue;
    if (t.error) continue;
    const startMs = t.time;
    const durationMs = t.action.twap.m * 60 * 1000;
    const endMs = startMs + durationMs;
    if (endMs <= nowMs) continue;

    const sizeBase = parseFloat(t.action.twap.s);
    if (!Number.isFinite(sizeBase) || sizeBase <= 0) continue;
    const valueUsd = sizeBase * hypePrice;
    const sign = t.action.twap.b ? 1 : -1;

    active += 1;

    // Per-window contribution. Cap effective end at the TWAP's actual
    // end so a 20-min TWAP that ends in 5min only contributes its
    // remaining 5min, not a full hour.
    for (const [lookahead, ref] of [
      [LOOKAHEAD_1H, "p1h"],
      [LOOKAHEAD_24H, "p24h"],
    ] as const) {
      const windowEnd = nowMs + lookahead;
      const effEnd = Math.min(endMs, windowEnd);
      const msInWindow = Math.max(0, effEnd - nowMs);
      const proRata = (valueUsd / durationMs) * msInWindow;
      if (ref === "p1h") p1h += sign * proRata;
      else p24h += sign * proRata;
    }
  }

  return {
    pressure_1h_usd: p1h,
    pressure_24h_usd: p24h,
    active_twap_count: active,
  };
}

// Convenience: fetch + compute in one call. Throws if HYPE price is
// missing — caller should fall back to skipping the snapshot rather
// than recording bogus zeros.
export async function getHypePressure(hypePrice: number): Promise<PressureResult> {
  if (!Number.isFinite(hypePrice) || hypePrice <= 0) {
    throw new Error(`getHypePressure: invalid hypePrice ${hypePrice}`);
  }
  const twaps = await fetchActiveTwaps();
  const computed = computePressureFromTwaps(twaps, hypePrice);
  return { ...computed, hype_price: hypePrice, source_ts: lastFetchTs };
}

export function getHypurrscanStats(): {
  totalFetches: number;
  totalErrors: number;
  lastFetchAgeMs: number;
  cacheSize: number;
} {
  return {
    totalFetches,
    totalErrors,
    lastFetchAgeMs: lastFetchTs ? Date.now() - lastFetchTs : Infinity,
    cacheSize: lastFetchData.length,
  };
}

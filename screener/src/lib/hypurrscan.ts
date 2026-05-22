// Hypurrscan client — fetches active TWAP orders across the entire HL
// market and computes the signed HYPE buy-pressure in dollars over a
// forward lookahead window.
//
// Architecture note: we use the /twap/* endpoint (returns ALL active
// TWAPs across all markets, ~150 KB) and filter to HYPE-related asset
// IDs locally. The earlier /twap/HYPE endpoint was a subset that only
// included HYPE-spot (a=10107) and missed HYPE-perp (a=159) TWAPs,
// which on a typical day account for the majority of the pressure.
//
// hypeMarketIds is the set we accept:
//   - 159   → HYPE perp (asset index in HL's meta.universe)
//   - 10107 → HYPE/USDC spot
// These are stable on HL mainnet; we keep them as a constant but expose
// an override on computePressureFromTwaps so a future re-indexing
// doesn't quietly break the metric.
//
// Per-TWAP formula (sums across all matching active orders):
//   start_ms      = twap.time
//   duration_ms   = twap.action.twap.m × 60 × 1000      (m is minutes)
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
// Skip the TWAP if `ended` is present (terminated) or end_ms <= now
// (already complete).

const HYPURR_API = "https://api.hypurrscan.io";
const FETCH_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

// HYPE asset IDs on HL mainnet. Hardcoded because they're stable across
// listings; the perp index 159 has been HYPE since launch, and the spot
// pair index 107 (id = 10000 + 107 = 10107) is fixed for the canonical
// HYPE/USDC pair. If HL ever re-indexes we'll see pressure suddenly drop
// to 0 and we'll know to update this.
export const HYPE_MARKET_IDS: number[] = [159, 10107];

// Raw shape returned by /twap/*. Fields we don't use are typed loosely
// to avoid pinning ourselves to undocumented internals.
interface RawTwap {
  time: number;
  user: string;
  action: {
    type: string;
    twap: {
      a: number;            // asset id (159 = HYPE perp, 10107 = HYPE spot)
      b: boolean;           // buy = true, sell = false
      s: string;            // size in base units
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
      // /twap/* returns ALL active TWAPs across every HL market. We
      // filter to HYPE-related asset IDs in computePressureFromTwaps.
      // Size is ~150KB at typical volume — fine for a 90s poller.
      const res = await fetch(`${HYPURR_API}/twap/*`, {
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
// re-fetching.
//
// Caller supplies the current HYPE mid (from our HL WS) so the formula
// uses the same price the UI shows. `marketIds` defaults to the HYPE
// perp + spot set; pass a different list to compute pressure for any
// other token (e.g. ["FART"] or whatever).
export function computePressureFromTwaps(
  twaps: RawTwap[],
  hypePrice: number,
  nowMs: number = Date.now(),
  marketIds: number[] = HYPE_MARKET_IDS,
): Omit<PressureResult, "hype_price" | "source_ts"> {
  let p1h = 0;
  let p24h = 0;
  let active = 0;
  const LOOKAHEAD_1H = 3_600_000;
  const LOOKAHEAD_24H = 86_400_000;
  const allowedIds = new Set(marketIds);

  for (const t of twaps) {
    if (t.ended) continue;
    if (t.error) continue;
    // Filter to HYPE-related markets only — /twap/* returns the whole
    // exchange, ~150KB of unrelated tickers per response.
    if (!allowedIds.has(t.action.twap.a)) continue;

    const startMs = t.time;
    const durationMs = t.action.twap.m * 60 * 1000;
    const endMs = startMs + durationMs;
    if (endMs <= nowMs) continue;

    const sizeBase = parseFloat(t.action.twap.s);
    if (!Number.isFinite(sizeBase) || sizeBase <= 0) continue;
    // Note: we use perp HYPE mid for both perp and spot TWAPs. Spot
    // HYPE typically prices within ~0.5–2% of the perp; using the perp
    // mid for both keeps the formula simple and the result well within
    // a couple-percent of hypurrscan's display. If we ever want exact
    // parity we'd plumb the spot mid (allMids key "@107") separately.
    const valueUsd = sizeBase * hypePrice;
    const sign = t.action.twap.b ? 1 : -1;

    active += 1;

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

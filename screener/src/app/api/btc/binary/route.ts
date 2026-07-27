import { NextResponse } from "next/server";
import { boundedRemainingTtl, cache } from "@/lib/cache";
import { getCurrentBtcBinary, annualizedRealizedVol, modelYesProbability } from "@/lib/btcBinary";
import {
  insertBtcBinarySnapshot,
  latestBtcBinarySnapshot,
  getCandlesBulkFromCache,
} from "@/lib/db";
import { startBtcBinaryPoller } from "@/lib/btcBinaryPoller";

export const dynamic = "force-dynamic";

const ROUTE_CACHE_TTL_MS = 30_000;
const SQLITE_FRESH_MS = 90_000;       // accept snapshots up to 90s old

function binaryResponse(body: BtcBinaryResponse, stale = false) {
  return NextResponse.json(body, {
    headers: {
      "X-Data-Stale": String(stale),
      "X-Data-Age-Ms": String(Math.max(0, Date.now() - body.generated_at)),
      "X-Data-Generated-At": String(body.generated_at),
    },
  });
}

export interface BtcBinaryResponse {
  generated_at: number;
  source: "live" | "sqlite";
  target_price: number;
  expiry_ms: number;
  ms_to_expiry: number;
  yes_price: number;
  no_price: number;
  // Sum of yes + no; should be ~1.0 (parity-enforced merged book).
  // Surfaced for debug so dislocations are obvious.
  parity_sum: number;
  // Market-implied probability of YES at settlement (= yes_price under
  // the standard "binary token trades at probability" interpretation).
  market_probability: number;
  // Model-implied probability of YES (Black-Scholes binary using
  // realized vol from cached BTC daily candles). null when we lack
  // enough candles to estimate vol.
  model_probability: number | null;
  // model - market. Positive = model thinks YES is undervalued.
  divergence: number | null;
  // Realized vol input to the model (annualized). Surfaced so the
  // user can sanity-check the model.
  realized_vol_30d: number | null;
  btc_mid: number;
}

export async function GET() {
  // Start on a real request; module imports also happen during `next build`.
  startBtcBinaryPoller();

  const cached = cache.get<BtcBinaryResponse>("api:btc:binary");
  if (cached) return binaryResponse(cached);

  const now = Date.now();

  // L2: serve from SQLite if the most recent snapshot is fresh enough.
  // We always recompute the model probability against current candles
  // even when serving from SQLite — the model is cheap (one log + a
  // normal CDF eval) and using the latest candles for vol is the
  // right move.
  const snap = latestBtcBinarySnapshot();
  if (snap && now - snap.ts < SQLITE_FRESH_MS) {
    const body = buildResponse({
      generated_at: snap.ts,
      source: "sqlite",
      target_price: snap.target_price,
      expiry_ms: snap.expiry_ms,
      yes_price: snap.yes_price,
      no_price: snap.no_price,
      btc_mid: snap.btc_mid,
      now,
    });
    cache.set("api:btc:binary", body, boundedRemainingTtl(ROUTE_CACHE_TTL_MS, now - snap.ts));
    return binaryResponse(body);
  }

  // L3: live fetch.
  try {
    const state = await getCurrentBtcBinary();
    if (!state) {
      return NextResponse.json(
        { error: "no active BTC binary outcome — possibly mid-rollover" },
        { status: 503 }
      );
    }
    if (state.yesMid == null || state.noMid == null || state.btcMid == null) {
      // Same as the snap path's stale-fallback: if WS hasn't ticked
      // outcome mids yet, hand back the freshest persisted row even if
      // it's older than the SQLite_FRESH window. Better than 503.
      if (snap) {
        const body = buildResponse({
          generated_at: snap.ts,
          source: "sqlite",
          target_price: snap.target_price,
          expiry_ms: snap.expiry_ms,
          yes_price: snap.yes_price,
          no_price: snap.no_price,
          btc_mid: snap.btc_mid,
          now,
          note: "WS mids not yet populated — serving last persisted snapshot",
        });
        return binaryResponse(body, true);
      }
      return NextResponse.json(
        { error: "outcome mids not yet streamed — try again in a moment" },
        { status: 503 }
      );
    }

    // Persist this fresh snapshot.
    insertBtcBinarySnapshot({
      ts: now,
      target_price: state.targetPrice,
      expiry_ms: state.expiryMs,
      yes_price: state.yesMid,
      no_price: state.noMid,
      btc_mid: state.btcMid,
    });

    const body = buildResponse({
      generated_at: now,
      source: "live",
      target_price: state.targetPrice,
      expiry_ms: state.expiryMs,
      yes_price: state.yesMid,
      no_price: state.noMid,
      btc_mid: state.btcMid,
      now,
    });
    cache.set("api:btc:binary", body, ROUTE_CACHE_TTL_MS);
    return binaryResponse(body);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// Build the response body, including computing model probability from
// the cached BTC daily candles. Extracted as a helper because the same
// shape is built from both the SQLite-fresh and live-fetch paths.
function buildResponse(opts: {
  generated_at: number;
  source: "live" | "sqlite";
  target_price: number;
  expiry_ms: number;
  yes_price: number;
  no_price: number;
  btc_mid: number;
  now: number;
  note?: string;
}): BtcBinaryResponse {
  // 30-day realized vol — pull a few extra bars so the latest in-
  // progress bar doesn't truncate us below 30.
  let realizedVol: number | null = null;
  try {
    const candles = getCandlesBulkFromCache(["BTC"], "1d", 32).get("BTC") ?? [];
    if (candles.length >= 5) {
      // Drop the last bar (in-progress today) so vol is based on closed bars.
      const closed = candles.slice(0, -1).map((c) => c.c);
      realizedVol = annualizedRealizedVol(closed);
    }
  } catch {
    // ignore — leave model probability null
  }

  let modelProb: number | null = null;
  if (realizedVol != null) {
    modelProb = modelYesProbability({
      spot: opts.btc_mid,
      strike: opts.target_price,
      ttlMs: Math.max(0, opts.expiry_ms - opts.now),
      sigmaAnnualized: realizedVol,
    });
  }

  return {
    generated_at: opts.generated_at,
    source: opts.source,
    target_price: opts.target_price,
    expiry_ms: opts.expiry_ms,
    ms_to_expiry: Math.max(0, opts.expiry_ms - opts.now),
    yes_price: opts.yes_price,
    no_price: opts.no_price,
    parity_sum: opts.yes_price + opts.no_price,
    market_probability: opts.yes_price,
    model_probability: modelProb,
    divergence: modelProb != null ? modelProb - opts.yes_price : null,
    realized_vol_30d: realizedVol,
    btc_mid: opts.btc_mid,
  };
}

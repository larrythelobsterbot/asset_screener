import { NextResponse } from "next/server";
import { boundedRemainingTtl, cache } from "@/lib/cache";
import { getMid } from "@/lib/hyperliquidWs";
import { getHypePressure } from "@/lib/hypurrscan";
import {
  insertHypePressureSnapshot,
  latestHypePressureSnapshot,
} from "@/lib/db";
import { startHypePressurePoller } from "@/lib/hypePressurePoller";

export const dynamic = "force-dynamic";

const ROUTE_CACHE_TTL_MS = 60_000;
// If the freshest persisted snapshot is younger than this, serve it
// instead of fetching. Lines up with the poller cadence (90s) so a
// route hit between polls returns the most recent poll's data.
const SQLITE_FRESH_MS = 120_000;

function pressureResponse(body: PressureResponse, stale = false) {
  return NextResponse.json(body, {
    headers: {
      "X-Data-Stale": String(stale),
      "X-Data-Age-Ms": String(Math.max(0, Date.now() - body.generated_at)),
      "X-Data-Generated-At": String(body.generated_at),
    },
  });
}

interface PressureResponse {
  generated_at: number;
  source: "live" | "sqlite" | "cache";
  pressure_1h_usd: number;
  pressure_24h_usd: number;
  hype_price: number;
  active_twap_count: number;
  threshold_usd: number;
}

const THRESHOLD_USD = parseFloat(
  process.env.HYPE_PRESSURE_ALERT_THRESHOLD_USD || "1000000"
);

export async function GET() {
  // Start on a real request; module imports also happen during `next build`.
  startHypePressurePoller();

  const cached = cache.get<PressureResponse>("api:hype:pressure");
  if (cached) return pressureResponse(cached);

  const now = Date.now();
  // L2: recent SQLite snapshot.
  const snap = latestHypePressureSnapshot();
  if (snap && now - snap.ts < SQLITE_FRESH_MS) {
    const body: PressureResponse = {
      generated_at: snap.ts,
      source: "sqlite",
      pressure_1h_usd: snap.pressure_1h_usd,
      pressure_24h_usd: snap.pressure_24h_usd,
      hype_price: snap.hype_price,
      active_twap_count: snap.active_twap_count,
      threshold_usd: THRESHOLD_USD,
    };
    cache.set("api:hype:pressure", body, boundedRemainingTtl(ROUTE_CACHE_TTL_MS, now - snap.ts));
    return pressureResponse(body);
  }

  // L3: live fetch + persist. Should only happen on cold start before
  // the poller's first tick lands.
  const hypePrice = getMid("HYPE");
  if (hypePrice == null) {
    // Best-effort fallback: return whatever we have in SQLite even if
    // stale. Better than an opaque 500 for a widget that polls.
    if (snap) {
      return pressureResponse({
        generated_at: snap.ts,
        source: "sqlite" as const,
        pressure_1h_usd: snap.pressure_1h_usd,
        pressure_24h_usd: snap.pressure_24h_usd,
        hype_price: snap.hype_price,
        active_twap_count: snap.active_twap_count,
        threshold_usd: THRESHOLD_USD,
      } as PressureResponse, true);
    }
    return NextResponse.json(
      { error: "HYPE mid not yet available — WS still connecting" },
      { status: 503 }
    );
  }

  try {
    const p = await getHypePressure(hypePrice);
    insertHypePressureSnapshot({
      ts: now,
      pressure_1h_usd: p.pressure_1h_usd,
      pressure_24h_usd: p.pressure_24h_usd,
      hype_price: p.hype_price,
      active_twap_count: p.active_twap_count,
    });
    const body: PressureResponse = {
      generated_at: now,
      source: "live",
      pressure_1h_usd: p.pressure_1h_usd,
      pressure_24h_usd: p.pressure_24h_usd,
      hype_price: p.hype_price,
      active_twap_count: p.active_twap_count,
      threshold_usd: THRESHOLD_USD,
    };
    cache.set("api:hype:pressure", body, ROUTE_CACHE_TTL_MS);
    return pressureResponse(body);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

export type { PressureResponse };

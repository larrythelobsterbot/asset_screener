import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import {
  computeHlDerivsWithMetadata,
  DERIVS_SOURCE_MAX_AGE_MS,
  type HlDerivsItem,
  type HlDerivsResponse,
} from "@/lib/hlDerivs";
import { assessPayloadFreshness } from "@/lib/positioningMetrics";
import { sourceAgeMs as observationAgeMs } from "@/lib/sourceObservation";

// v2: HL-native. Computed on demand from our own price_snapshots history
// (see lib/hlDerivs.ts) — the Coinalyze poller is retired (free-tier quota
// was unusable; Binance/Bybit geo-block this VPS). No poller to boot:
// the instrumentation keepalive keeps snapshots flowing, and this route
// derives regime/deltas/sparklines from them at read time.

export const dynamic = "force-dynamic";
const ROUTE_CACHE_TTL_MS = 20_000;
const MAX_STALE_MS = 10 * 60_000;
const CACHE_KEY = "api:derivs:v2";

export type { HlDerivsItem, HlDerivsResponse };

function responseFor(payload: HlDerivsResponse, error?: string): Response {
  const now = Date.now();
  const freshness = assessPayloadFreshness(
    payload.metadata.generatedAt,
    now,
    ROUTE_CACHE_TTL_MS,
    MAX_STALE_MS,
  );
  const sourceAgeMs = observationAgeMs(payload.metadata.sourceObservedAt, now);
  const sourceUnavailable = sourceAgeMs == null;
  const sourceStale = sourceUnavailable || sourceAgeMs > DERIVS_SOURCE_MAX_AGE_MS;
  const failedSources = payload.metadata.failedSources ?? [];
  const staleSources = payload.metadata.staleSources ?? [];
  const partial = payload.metadata.partial || sourceStale || failedSources.length > 0 || staleSources.length > 0;
  const stale = payload.metadata.stale || freshness.status !== "fresh" || sourceStale;
  const metadata = {
    ...payload.metadata,
    sourceAgeMs,
    ageMs: freshness.ageMs ?? payload.metadata.ageMs,
    status: stale ? "stale" as const : "fresh" as const,
    stale,
    partial,
    failedSources,
    staleSources,
    ...(error ? { error } : {}),
  };
  return NextResponse.json({ items: payload.items, metadata }, { headers: NO_STORE });
}

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "CDN-Cache-Control": "no-store",
};

export async function GET() {
  const cached = cache.get<HlDerivsResponse>(CACHE_KEY);
  if (cached) return responseFor(cached);
  try {
    const computation = await computeHlDerivsWithMetadata();
    const generatedAt = Date.now();
    const payload: HlDerivsResponse = {
      items: computation.items,
      metadata: {
        generatedAt,
        sourceObservedAt: computation.sourceObservedAt,
        sourceAgeMs: observationAgeMs(computation.sourceObservedAt, generatedAt),
        ageMs: 0,
        status: "fresh",
        stale: false,
        partial: computation.partial,
        failedSources: computation.failedSources,
        staleSources: computation.staleSources,
      },
    };
    cache.set(CACHE_KEY, payload, ROUTE_CACHE_TTL_MS);
    return responseFor(payload);
  } catch (err) {
    const stale = cache.getStaleWithin<HlDerivsResponse>(CACHE_KEY, MAX_STALE_MS);
    if (stale) return responseFor(stale, String(err));
    return NextResponse.json({
      error: String(err),
      metadata: { status: "expired", stale: true, generatedAt: null, ageMs: null },
    }, { status: 502, headers: NO_STORE });
  }
}

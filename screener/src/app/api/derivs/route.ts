import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import { latestDerivsSnapshots, type DerivsRow } from "@/lib/db";
import { startCoinalyzePoller } from "@/lib/coinalyzePoller";

// Boot the derivs poller alongside the route (idempotent). The poller
// writes derivs_snapshots; this route is the read surface for the Radar.
startCoinalyzePoller();

export const dynamic = "force-dynamic";
const ROUTE_CACHE_TTL_MS = 15_000;

export interface DerivsItem {
  base: string;
  ts: number;
  oiUsd: number;
  oiHlUsd: number | null;
  fundingHl: number | null;
  liqLongUsd: number | null;
  liqShortUsd: number | null;
  oiDeltaPct: number | null;
  price: number | null;
  priceDeltaPct: number | null;
  regime: string | null;
  venues: number | null;
}

function toItem(r: DerivsRow): DerivsItem {
  return {
    base: r.base,
    ts: r.ts,
    oiUsd: r.oi_usd,
    oiHlUsd: r.oi_hl_usd,
    fundingHl: r.funding_hl,
    liqLongUsd: r.liq_long_usd,
    liqShortUsd: r.liq_short_usd,
    oiDeltaPct: r.oi_delta_pct,
    price: r.price,
    priceDeltaPct: r.price_delta_pct,
    regime: r.regime,
    venues: r.venues,
  };
}

export async function GET() {
  const NO_STORE = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "CDN-Cache-Control": "no-store",
  };
  const cached = cache.get<DerivsItem[]>("api:derivs");
  if (cached) return NextResponse.json({ items: cached }, { headers: NO_STORE });

  const items = latestDerivsSnapshots().map(toItem);
  cache.set("api:derivs", items, ROUTE_CACHE_TTL_MS);
  return NextResponse.json({ items }, { headers: NO_STORE });
}

import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import { computeHlDerivs, type HlDerivsItem } from "@/lib/hlDerivs";

// v2: HL-native. Computed on demand from our own price_snapshots history
// (see lib/hlDerivs.ts) — the Coinalyze poller is retired (free-tier quota
// was unusable; Binance/Bybit geo-block this VPS). No poller to boot:
// the instrumentation keepalive keeps snapshots flowing, and this route
// derives regime/deltas/sparklines from them at read time.

export const dynamic = "force-dynamic";
const ROUTE_CACHE_TTL_MS = 20_000;

export type { HlDerivsItem };

export async function GET() {
  const NO_STORE = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "CDN-Cache-Control": "no-store",
  };
  const cached = cache.get<HlDerivsItem[]>("api:derivs:v2");
  if (cached) return NextResponse.json({ items: cached }, { headers: NO_STORE });
  try {
    const items = await computeHlDerivs();
    cache.set("api:derivs:v2", items, ROUTE_CACHE_TTL_MS);
    return NextResponse.json({ items }, { headers: NO_STORE });
  } catch (err) {
    const stale = cache.getStale<HlDerivsItem[]>("api:derivs:v2");
    if (stale) return NextResponse.json({ items: stale }, { headers: NO_STORE });
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import { fetchWithTimeout } from "@/lib/fetchWithTimeout";

// Proxy to the user's own variational-api service (separate PM2 app on
// this VPS, 127.0.0.1:8002). It tracks Variational funding rates vs other
// venues and computes funding-arb opportunities — directly relevant since
// the user currently trades on Variational to farm points. Proxied because
// the browser can't reach the VPS-local port; upstream caches 5min, we add
// a short layer so terminal polling stays cheap.

export const dynamic = "force-dynamic";

const UPSTREAM = process.env.VARIATIONAL_LOCAL_API ?? "http://127.0.0.1:8002";
const TTL_MS = 60_000;

export interface VariationalOpportunity {
  ticker: string;
  var_rate_annual: number;
  cex_exchange: string;
  cex_rate_annual: number;
  spread_annual: number;
  direction: string;
  daily_pnl_10k: number;
  var_mark_price: number;
  volume_24h: number;
}

export interface VariationalResponse {
  summary: {
    total_markets_tracked: number;
    total_opportunities: number;
    best_spread_ticker: string;
    best_spread_annual: number;
    avg_spread_annual: number;
    updated_at: string;
  } | null;
  opportunities: VariationalOpportunity[];
}

export async function GET() {
  const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" };
  const cached = cache.get<VariationalResponse>("api:variational");
  if (cached) return NextResponse.json(cached, { headers: NO_STORE });

  try {
    const [sumRes, oppRes] = await Promise.all([
      fetchWithTimeout(`${UPSTREAM}/api/rates/summary`, {}, 25_000),
      fetchWithTimeout(`${UPSTREAM}/api/rates/opportunities`, {}, 25_000),
    ]);
    const summary = sumRes.ok ? await sumRes.json() : null;
    const oppJson = oppRes.ok ? await oppRes.json() : { opportunities: [] };
    const body: VariationalResponse = {
      summary,
      opportunities: Array.isArray(oppJson?.opportunities) ? oppJson.opportunities : [],
    };
    cache.set("api:variational", body, TTL_MS);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch {
    const stale = cache.getStale<VariationalResponse>("api:variational");
    if (stale) return NextResponse.json(stale, { headers: NO_STORE });
    // Service down — return an empty-but-valid shape so the panel renders
    // its offline state instead of erroring.
    return NextResponse.json(
      { summary: null, opportunities: [] } satisfies VariationalResponse,
      { headers: NO_STORE }
    );
  }
}

import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import { smartFlowAt, trackedWallets } from "@/lib/db";
import { computeSmartFlowRows, type SmartFlowCoin } from "@/lib/smartFlow";
import type { AssetData } from "@/lib/types";

// This is the divergence read between the sharp cohort and the crowd:
// aggregate the tracked wallets' current positioning (smartFlowAt on
// wallet_positions, written by the poller in lib/walletPoller.ts) and
// diff it against itself 1h and 24h ago, then join the crowd's total-OI
// change from the ALREADY-COMPUTED /api/markets cache. This route is
// SQLite + in-memory-cache only — it never calls Hyperliquid and never
// recomputes crowd OI; if the markets cache is cold, crowdOiChange24hPct
// is simply null for every coin.

export const dynamic = "force-dynamic";
const ROUTE_CACHE_TTL_MS = 60_000;
const CACHE_KEY = "api:smart-flow";

export type { SmartFlowCoin };

interface SmartFlowResponse {
  generatedAt: number;
  coins: SmartFlowCoin[];
}

function computeResponse(): SmartFlowResponse {
  const now = Date.now();

  // One wallet list for all three points in time. Two reasons, both
  // load-bearing: (1) deltas must compare the SAME cohort against itself —
  // mixing wallet sets conflates position changes with composition changes
  // (a wallet demoted an hour ago would inflate the -24h side and show a
  // phantom outflow); (2) the unscoped fallback walks every address ever
  // seen in 30 days of history — a set that only grows as the cohort
  // churns — measured at ~600ms of synchronous SQLite per call at
  // projected scale, vs ~14ms scoped to the registry.
  const cohort = trackedWallets().map((w) => w.address);

  // Every lookback window must be WIDER than the poller's 15-min cadence,
  // or it structurally misses cycles: smartFlowAt's window is one-sided
  // ([target - maxAge, target]), and a 10-min window against 15-min-apart
  // cycle timestamps came back empty on a measured ~32% of requests —
  // flickering the whole Δ1h column to "warming up" forever. 20min
  // guarantees at least one cycle (cadence + sweep time + margin).
  const nowMap = smartFlowAt(now, 20 * 60_000, cohort);
  const map1h = smartFlowAt(now - 3_600_000, 20 * 60_000, cohort);
  const map24h = smartFlowAt(now - 24 * 3_600_000, 2 * 3_600_000, cohort);

  // Crowd OI-change%, read from /api/markets' own response cache — never
  // recomputed here. A cold cache (route hasn't served yet, or its TTL
  // lapsed) yields an empty map, which is exactly "null for every coin".
  const crowdBySymbol = new Map<string, number | null>();
  const markets = cache.get<AssetData[]>("api:markets");
  if (markets) {
    for (const a of markets) crowdBySymbol.set(a.symbol, a.oiChange24hPct);
  }

  const coins = computeSmartFlowRows(nowMap, map1h, map24h, crowdBySymbol);
  return { generatedAt: now, coins };
}

export async function GET() {
  const NO_STORE = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "CDN-Cache-Control": "no-store",
  };

  const cached = cache.get<SmartFlowResponse>(CACHE_KEY);
  if (cached) return NextResponse.json(cached, { headers: NO_STORE });

  try {
    const body = computeResponse();
    cache.set(CACHE_KEY, body, ROUTE_CACHE_TTL_MS);
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (err) {
    const stale = cache.getStale<SmartFlowResponse>(CACHE_KEY);
    if (stale) return NextResponse.json(stale, { headers: NO_STORE });
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}

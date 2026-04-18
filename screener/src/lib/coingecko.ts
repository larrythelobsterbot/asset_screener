import { cache } from "./cache";
import { COINGECKO_IDS } from "@/config/sectors";

const CG_API = "https://api.coingecko.com/api/v3";

export interface CGMarketData {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  market_cap_rank: number;
}

async function cgGet<T>(path: string): Promise<T> {
  // Opt out of Next.js 14's fetch caching — our own TTL cache wraps this
  // function and should be the single source of truth for freshness.
  const res = await fetch(`${CG_API}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (res.status === 429) throw new Error("CoinGecko rate limited");
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getMarkets(): Promise<CGMarketData[]> {
  const cached = cache.get<CGMarketData[]>("cg:markets");
  if (cached) return cached;

  try {
    const data = await cgGet<CGMarketData[]>(
      `/coins/markets?vs_currency=usd&ids=${COINGECKO_IDS.join(",")}&order=market_cap_desc&sparkline=false&price_change_percentage=1h,24h,7d`
    );
    cache.set("cg:markets", data, 60_000);
    return data;
  } catch {
    const stale = cache.getStale<CGMarketData[]>("cg:markets");
    if (stale) return stale;
    return [];
  }
}

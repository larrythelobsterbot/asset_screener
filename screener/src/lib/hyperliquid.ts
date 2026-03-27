import { cache } from "./cache";

const HL_API = "https://api.hyperliquid.xyz/info";

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface HLAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx?: string;
}

export interface HLMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
  }>;
}

export interface HLCandle {
  t: number;
  T: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
  n: number;
}

export async function getMetaAndCtxs(): Promise<{ meta: HLMeta; assetCtxs: HLAssetCtx[] }> {
  const cached = cache.get<{ meta: HLMeta; assetCtxs: HLAssetCtx[] }>("hl:metaAndCtxs");
  if (cached) return cached;

  const data = await hlPost<[HLMeta, HLAssetCtx[]]>({ type: "metaAndAssetCtxs" });
  const result = { meta: data[0], assetCtxs: data[1] };
  cache.set("hl:metaAndCtxs", result, 30_000);
  return result;
}

export async function getAllMids(): Promise<Record<string, string>> {
  const cached = cache.get<Record<string, string>>("hl:allMids");
  if (cached) return cached;

  const data = await hlPost<Record<string, string>>({ type: "allMids" });
  cache.set("hl:allMids", data, 30_000);
  return data;
}

export async function getCandles(
  coin: string,
  interval: string = "4h",
  count: number = 350
): Promise<HLCandle[]> {
  const cacheKey = `hl:candles:${coin}:${interval}`;
  const cached = cache.get<HLCandle[]>(cacheKey);
  if (cached) return cached;

  const intervalMs: Record<string, number> = {
    "1h": 3_600_000,
    "4h": 14_400_000,
    "1d": 86_400_000,
  };
  const ms = intervalMs[interval] || 14_400_000;
  const endTime = Date.now();
  const startTime = endTime - count * ms;

  const data = await hlPost<HLCandle[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });

  cache.set(cacheKey, data, 300_000);
  return data;
}

export async function getFundingHistory(
  coin: string,
  hours: number = 168
): Promise<Array<{ coin: string; fundingRate: string; premium: string; time: number }>> {
  const cacheKey = `hl:funding:${coin}`;
  const cached = cache.get<Array<{ coin: string; fundingRate: string; premium: string; time: number }>>(cacheKey);
  if (cached) return cached;

  const endTime = Date.now();
  const startTime = endTime - hours * 3_600_000;

  const data = await hlPost<Array<{ coin: string; fundingRate: string; premium: string; time: number }>>({
    type: "fundingHistory",
    coin,
    startTime,
    endTime,
  });

  cache.set(cacheKey, data, 300_000);
  return data;
}

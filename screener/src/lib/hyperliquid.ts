import { cache } from "./cache";

const HL_API = "https://api.hyperliquid.xyz/info";

// ── Token-bucket rate limiter ────────────────────────────────────────────
// Hyperliquid's published limit is ~1200 req/min per IP on the /info endpoint.
// We cap ourselves at 10 req/s sustained with a burst of 20, leaving headroom
// for the future signal-bot process that will share this IP.

const HL_RATE_PER_SEC = 10;
const HL_BURST = 20;

let hlTokens = HL_BURST;
let hlLastRefill = Date.now();
const hlWaitQueue: Array<() => void> = [];

function refillTokens(): void {
  const now = Date.now();
  const elapsed = (now - hlLastRefill) / 1000;
  if (elapsed <= 0) return;
  hlTokens = Math.min(HL_BURST, hlTokens + elapsed * HL_RATE_PER_SEC);
  hlLastRefill = now;
}

function acquireToken(): Promise<void> {
  refillTokens();
  if (hlTokens >= 1) {
    hlTokens -= 1;
    return Promise.resolve();
  }
  // Not enough tokens — queue caller; wake them when the bucket refills.
  return new Promise((resolve) => {
    hlWaitQueue.push(resolve);
    scheduleQueueDrain();
  });
}

let drainTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleQueueDrain(): void {
  if (drainTimer || hlWaitQueue.length === 0) return;
  // Time until at least one token is available
  const missing = Math.max(0, 1 - hlTokens);
  const waitMs = Math.ceil((missing / HL_RATE_PER_SEC) * 1000);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    refillTokens();
    while (hlTokens >= 1 && hlWaitQueue.length > 0) {
      hlTokens -= 1;
      const resolve = hlWaitQueue.shift()!;
      resolve();
    }
    if (hlWaitQueue.length > 0) scheduleQueueDrain();
  }, Math.max(10, waitMs));
}

// Counters for observability — read via getHlRateLimitStats()
let hlRequestCount = 0;
let hlErrorCount = 0;
let hlRateWaitCount = 0;

export function getHlRateLimitStats(): {
  requests: number;
  errors: number;
  rateWaits: number;
  tokensAvailable: number;
  queueDepth: number;
} {
  refillTokens();
  return {
    requests: hlRequestCount,
    errors: hlErrorCount,
    rateWaits: hlRateWaitCount,
    tokensAvailable: Math.floor(hlTokens),
    queueDepth: hlWaitQueue.length,
  };
}

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  if (hlTokens < 1) hlRateWaitCount += 1;
  await acquireToken();
  hlRequestCount += 1;
  try {
    // Next.js 14 App Router auto-caches fetch() responses — POST included —
    // unless we opt out explicitly. Without `cache: "no-store"` the same
    // metaAndCtxs response gets served to us forever from Next's fetch
    // cache, which is exactly the bug that made markets prices freeze.
    const res = await fetch(HL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      // Back off hard on 429 — return the tokens so downstream callers don't
      // stampede, and surface a typed error.
      if (res.status === 429) {
        hlTokens = 0;
        hlLastRefill = Date.now();
      }
      hlErrorCount += 1;
      throw new Error(`Hyperliquid API error: ${res.status}`);
    }
    return res.json() as Promise<T>;
  } catch (err) {
    hlErrorCount += 1;
    throw err;
  }
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

// These two endpoints are called on every signals scan AND every markets
// request, so SWR pays off handsomely: on cache expiry, the first caller
// gets stale data instantly (single-digit ms) and a background refresh
// fires once — even if ten concurrent callers arrive in that window,
// they all get the same inflight refresh promise instead of spamming HL.
export async function getMetaAndCtxs(): Promise<{ meta: HLMeta; assetCtxs: HLAssetCtx[] }> {
  return cache.getWithRefresh(
    "hl:metaAndCtxs",
    async () => {
      const data = await hlPost<[HLMeta, HLAssetCtx[]]>({ type: "metaAndAssetCtxs" });
      return { meta: data[0], assetCtxs: data[1] };
    },
    30_000
  );
}

export async function getAllMids(): Promise<Record<string, string>> {
  return cache.getWithRefresh(
    "hl:allMids",
    () => hlPost<Record<string, string>>({ type: "allMids" }),
    30_000
  );
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

export interface HLSpotCtx {
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  circulatingSupply: string;
}

export interface HLSpotMeta {
  universe: Array<{
    name: string;
    tokens: [number, number];
    index: number;
    isCanonical: boolean;
  }>;
  tokens: Array<{
    name: string;
    index: number;
  }>;
}

export async function getSpotMetaAndCtxs(): Promise<{ meta: HLSpotMeta; spotCtxs: HLSpotCtx[] }> {
  const cached = cache.get<{ meta: HLSpotMeta; spotCtxs: HLSpotCtx[] }>("hl:spotMetaAndCtxs");
  if (cached) return cached;

  const data = await hlPost<[HLSpotMeta, HLSpotCtx[]]>({ type: "spotMetaAndAssetCtxs" });
  const result = { meta: data[0], spotCtxs: data[1] };
  cache.set("hl:spotMetaAndCtxs", result, 30_000);
  return result;
}

export async function getBuilderDexData(dex: string): Promise<{ meta: HLMeta; assetCtxs: HLAssetCtx[] }> {
  const cacheKey = `hl:builderDex:${dex}`;
  const cached = cache.get<{ meta: HLMeta; assetCtxs: HLAssetCtx[] }>(cacheKey);
  if (cached) return cached;

  // HL's `dex` parameter on `metaAndAssetCtxs` is a relatively recent
  // addition and the response shape for builder-deployed DEXes isn't
  // documented as formally as the core endpoint. Validate the tuple shape
  // defensively so an API change surfaces as a clear error rather than an
  // opaque runtime failure (undefined.universe, etc).
  const data = await hlPost<unknown>({ type: "metaAndAssetCtxs", dex });
  if (
    !Array.isArray(data) ||
    data.length < 2 ||
    typeof data[0] !== "object" ||
    data[0] === null ||
    !Array.isArray((data[0] as HLMeta).universe) ||
    !Array.isArray(data[1])
  ) {
    throw new Error(
      `Hyperliquid builder-dex response for "${dex}" has unexpected shape — API may have changed`
    );
  }
  const result = { meta: data[0] as HLMeta, assetCtxs: data[1] as HLAssetCtx[] };
  cache.set(cacheKey, result, 30_000);
  return result;
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

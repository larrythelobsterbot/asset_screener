import { cache } from "./cache";
import { upsertCandles, getCandlesFromCache, type CandleRow } from "./db";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { BUILDER_DEXES } from "@/config/sectors";

const HL_API = "https://api.hyperliquid.xyz/info";

// ── Fractionally-quoted markets ──────────────────────────────────────────
// HL quotes a few perps at a fixed fraction of the level a human expects:
// its SPX contract trades at index/20000 (raw markPx ~0.37 for a ~7400
// index). Anything user-facing scales that up; price_snapshots stores the
// SCALED mark (verified continuous across the full 30d retention on
// 2026-07-14), so historical reads are in display units too.
//
// The trap this exists to prevent: openInterest is denominated in COINS,
// so `openInterest × displayPrice` silently inherits the scale factor.
// That shipped SPX as $54.2B of OI against $2.3M of daily volume — the
// largest market on the board, 20000x its real $2.7M. Any code pairing a
// coin quantity with a price must use rawPriceOf().
//
// Equally: never mix a raw price with a scaled one. Comparing HL's live
// markPx against a stored snapshot mark for SPX yields a ~-99.99% delta.
//
// Keyed by HL symbol; absent => scale 1 (the overwhelmingly common case).
export const PRICE_DISPLAY_SCALE: Record<string, number> = { SPX: 20000 };

export function displayScaleOf(symbol: string): number {
  return PRICE_DISPLAY_SCALE[symbol] ?? 1;
}

// The price in HL's own quote units — what a coin-denominated size must be
// multiplied by to get USD. Takes a DISPLAY price (live or historical).
export function rawPriceOf(symbol: string, displayPrice: number): number {
  return displayPrice / displayScaleOf(symbol);
}

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
    // 10s timeout — HL is fast (typically < 200ms) so anything over
    // 10s is almost certainly an outage; we'd rather fail fast and let
    // the cache fall back to stale data than pin a request handler.
    const res = await fetchWithTimeout(HL_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    }, 10_000);
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

// Layered candle storage:
//   1. In-memory cache, keyed by (coin, interval) ONLY — not by count —
//      so a caller asking for 200 bars and another asking for 350 bars
//      hit the same memory slot. The cached array is the largest seen
//      window; we slice the requested tail off it.
//   2. SQLite candles_cache table — survives PM2 restarts and lets the
//      cold-start path serve sparklines/indicators without HL calls.
//   3. Hyperliquid fetch — only when both above miss.
//
// HL returns the most recent `count * interval_ms` candles ending at
// endTime. Treating count as part of the cache key (the old behaviour)
// meant /api/asset (count=350) and /api/signals (count=350 for 4h but
// 200 for 1h, 300 for 1d) couldn't share — and worse, two routes asking
// for the same TF with the same count *with different endTime* would
// thrash on the route-cache boundary. Keying on (coin, interval) and
// caching the largest window observed fixes both.

const HL_CANDLE_TTL_MS = 300_000;

function intervalMs(interval: string): number {
  switch (interval) {
    case "1h": return 3_600_000;
    case "4h": return 14_400_000;
    case "1d": return 86_400_000;
    default:   return 14_400_000;
  }
}

function tailSlice(rows: HLCandle[], count: number): HLCandle[] {
  return rows.length <= count ? rows : rows.slice(rows.length - count);
}

function candleRowsToHL(rows: CandleRow[]): HLCandle[] {
  // SQLite stores numerics; HL's wire format uses strings. We re-stringify
  // here so downstream code (which already calls parseFloat) is unchanged.
  return rows.map((r) => ({
    t: r.t,
    T: r.t + intervalMs(r.interval),
    o: String(r.o), h: String(r.h), l: String(r.l), c: String(r.c),
    v: String(r.v),
    n: 0,
  }));
}

function hlToCandleRows(coin: string, interval: string, candles: HLCandle[]): CandleRow[] {
  return candles.map((c) => ({
    symbol: coin,
    interval,
    t: c.t,
    o: parseFloat(c.o),
    h: parseFloat(c.h),
    l: parseFloat(c.l),
    c: parseFloat(c.c),
    v: parseFloat(c.v),
  }));
}

// `cacheSymbol` splits the market's WIRE address from its identity in this
// app. HIP-3 candles must be fetched under the dex-prefixed coin — HL
// returns null for a bare "SKHX" and for "km:SKHX" (wrong dex); only
// "xyz:SKHX" works — but everything downstream (price_snapshots,
// getCandlesBulkFromCache, the UI) keys off the bare ticker. Passing
// cacheSymbol="SKHX" with coin="xyz:SKHX" bridges the two, which is what
// lets /api/markets pick HIP-3 candles up with no change at that call site.
// Defaults to `coin`, so every existing caller is unaffected.
export async function getCandles(
  coin: string,
  interval: string = "4h",
  count: number = 350,
  cacheSymbol: string = coin,
): Promise<HLCandle[]> {
  const cacheKey = `hl:candles:${cacheSymbol}:${interval}`;
  const cached = cache.get<HLCandle[]>(cacheKey);
  if (cached && cached.length >= count) return tailSlice(cached, count);

  // L2: SQLite. If we have enough rows AND the newest one is fresher than
  // the in-memory TTL, serve from disk + populate the memory cache.
  try {
    const dbRows = getCandlesFromCache(cacheSymbol, interval, count);
    if (dbRows.length >= count) {
      const newest = dbRows[dbRows.length - 1];
      const age = Date.now() - newest.t - intervalMs(interval);
      if (age < HL_CANDLE_TTL_MS) {
        const hl = candleRowsToHL(dbRows);
        cache.set(cacheKey, hl, HL_CANDLE_TTL_MS);
        return tailSlice(hl, count);
      }
    }
  } catch (err) {
    console.warn(`[hl.getCandles] sqlite read failed for ${cacheSymbol}:${interval}:`, err);
  }

  // L3: hit HL.
  const ms = intervalMs(interval);
  const endTime = Date.now();
  const startTime = endTime - count * ms;

  // HL returns null (not []) for an unknown coin — e.g. a HIP-3 ticker
  // requested without its dex prefix. Normalise so callers and the cache
  // never see null where an array is typed.
  const data = (await hlPost<HLCandle[] | null>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  })) ?? [];

  cache.set(cacheKey, data, HL_CANDLE_TTL_MS);
  // Fire-and-forget persistence — TRULY off the hot path. We use
  // setImmediate so the synchronous SQLite transaction (200–350 rows
  // per call, ~5–15ms in WAL mode) lands on the next event-loop tick
  // instead of blocking this route's response. The previous "fire-
  // and-forget" comment was misleading: the call was synchronous in
  // the request path.
  setImmediate(() => {
    try {
      upsertCandles(hlToCandleRows(cacheSymbol, interval, data));
    } catch (err) {
      console.warn(`[hl.getCandles] sqlite write failed for ${cacheSymbol}:${interval}:`, err);
    }
  });
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

// ── HIP-4 outcomes ────────────────────────────────────────────────────
// Schema (current): { outcomes: OutcomeSpec[], questions: QuestionSpec[] }
// Outcomes are individual binary contracts; questions group multiple
// outcomes that all settle together (exactly one resolves Yes). The
// recurring daily BTC binary is a single outcome (no question wrapper).
//
// description follows a pipe-delimited mini-language:
//   class:priceBinary|underlying:BTC|expiry:20260523-0600|targetPrice:77451|period:1d
//
// Outcome asset ID encoding (per docs/asset-ids):
//   asset_id = 100_000_000 + 10 * outcome + side
//   yes = side 0, no = side 1
//   spot coin string: "#" + (10*outcome+side)    e.g. "#800"
//
// We cache for 30s — outcomeMeta only changes daily at 06:00 UTC when
// the new contract gets deployed, but a tighter TTL means we pick up
// the new contract within 30s of rollover.

export interface OutcomeSpec {
  outcome: number;
  name: string;
  description: string;
  sideSpecs: Array<{ name: string }>;
}

export interface OutcomeMeta {
  outcomes: OutcomeSpec[];
  questions: Array<{
    question: number;
    name: string;
    description: string;
    fallbackOutcome?: number;
    namedOutcomes?: number[];
  }>;
}

export async function getOutcomeMeta(): Promise<OutcomeMeta> {
  return cache.getWithRefresh(
    "hl:outcomeMeta",
    () => hlPost<OutcomeMeta>({ type: "outcomeMeta" }),
    30_000
  );
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

// Deduped list of HIP-3 (builder-deployed) markets, ordered by 24h notional.
//
// `ticker` is the bare identity everything in this app keys on; `coin` is the
// dex-prefixed address HL's API demands. Dedup precedence MUST stay in step
// with /api/markets (native HL wins a ticker outright, then the earliest dex
// in BUILDER_DEXES) — otherwise a warmed candle series could be filed under a
// ticker that the markets route resolves to a different venue's contract.
export async function getBuilderUniverse(): Promise<
  Array<{ ticker: string; coin: string; dex: string; vol: number }>
> {
  const [native, ...results] = await Promise.all([
    getMetaAndCtxs().catch(() => null),
    ...BUILDER_DEXES.map((dex) => getBuilderDexData(dex).catch(() => null)),
  ]);
  // If the NATIVE universe is unavailable, abort the whole cycle instead of
  // proceeding with an empty `taken` set. Several builder dexes list tickers
  // that native HL owns (km:BTC, km:TSLA, ...); with `taken` empty those
  // would be emitted as builder-owned, and the candle warmer would then
  // upsert the BUILDER venue's candles over the native symbol's rows in
  // candles_cache (on conflict do update) — silently corrupting RSI/ATH/7d
  // for native markets long after the transient fetch failure healed.
  // A skipped warm cycle costs nothing (next one is 6h away, data ages
  // gracefully); cross-venue corruption is persistent.
  if (!native) {
    console.warn("[builder-universe] native meta unavailable — skipping cycle (dedup would be unsafe)");
    return [];
  }
  const taken = new Set<string>(native.meta.universe.map((u) => u.name));
  const out: Array<{ ticker: string; coin: string; dex: string; vol: number }> = [];
  for (let d = 0; d < BUILDER_DEXES.length; d++) {
    const dex = BUILDER_DEXES[d];
    const data = results[d];
    if (!data) continue;
    for (let i = 0; i < data.meta.universe.length; i++) {
      const raw = data.meta.universe[i].name;
      const ticker = raw.includes(":") ? raw.split(":")[1] : raw;
      if (taken.has(ticker)) continue;
      const ctx = data.assetCtxs[i];
      const vol = parseFloat(ctx?.dayNtlVlm || "0");
      if (!ctx || !(vol > 0)) continue; // ghost listing
      taken.add(ticker);
      // Always address HL with the prefix, even when the universe entry
      // came back bare — "SKHX" and "km:SKHX" both return null; only
      // "xyz:SKHX" (its actual dex) resolves.
      out.push({ ticker, coin: raw.includes(":") ? raw : `${dex}:${ticker}`, dex, vol });
    }
  }
  return out.sort((a, b) => b.vol - a.vol);
}

// ── clearinghouseState (smart-money flow poller) ─────────────────────────
//
// Per-wallet account + position snapshot. NO caching here, unlike every
// other function in this file — each call addresses a distinct user, so
// there is nothing to reuse across callers the way metaAndCtxs or candles
// are shared. Goes through the same hlPost/token-bucket path as everything
// else so the wallet poller's 300ms-paced sweep is naturally rate-limited
// alongside user-facing HL calls.
export interface HLClearinghouseState {
  marginSummary: { accountValue: string };
  assetPositions: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string | null;
      positionValue: string;
      unrealizedPnl: string;
      leverage: { value: number };
    };
  }>;
  time: number;
}

export async function getClearinghouseState(user: string): Promise<HLClearinghouseState> {
  const data = await hlPost<unknown>({ type: "clearinghouseState", user });
  // Same defensive-validation shape as getBuilderDexData. This is the
  // OFFICIAL api host (unlike the leaderboard's stats host), but the
  // response shape isn't versioned, and callers here are per-wallet
  // try/catch in the poller — a descriptive throw lets one malformed
  // wallet fail cleanly instead of an opaque `undefined.marginSummary`
  // crash taking the sweep down.
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { marginSummary?: unknown }).marginSummary !== "object" ||
    (data as { marginSummary?: unknown }).marginSummary === null ||
    typeof (data as { marginSummary: { accountValue?: unknown } }).marginSummary.accountValue !== "string" ||
    !Array.isArray((data as { assetPositions?: unknown }).assetPositions) ||
    typeof (data as { time?: unknown }).time !== "number"
  ) {
    throw new Error(
      `Hyperliquid clearinghouseState response for "${user}" has unexpected shape — API may have changed`
    );
  }
  const assetPositions = (data as HLClearinghouseState).assetPositions;
  for (const ap of assetPositions) {
    const p = ap?.position;
    if (
      !p ||
      typeof p.coin !== "string" ||
      typeof p.szi !== "string" ||
      typeof p.positionValue !== "string" ||
      typeof p.unrealizedPnl !== "string"
    ) {
      throw new Error(
        `Hyperliquid clearinghouseState response for "${user}" has a malformed position entry`
      );
    }
  }
  return data as HLClearinghouseState;
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

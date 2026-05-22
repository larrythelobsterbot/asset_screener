// Elfa AI v2 client — narrow, budget-aware.
//
// The free tier is 1000 requests/day. Every call costs 1 credit. We
// guard each call against a per-day soft cap (default 950 — leaves
// headroom for ops/diagnostic calls) and refuse cleanly when over.
//
// The full SDK (@elfa-ai/sdk on npm) wraps every endpoint; we only need
// a couple of methods so a hand-rolled client keeps the dep tree slim.
// Auth header: `x-elfa-api-key: <token>`.
//
// Endpoints we use:
//   GET /v2/key-status          (free — doesn't count against quota)
//   GET /v2/aggregations/trending-tokens?timeWindow=24h&pageSize=200
//
// All other endpoints (data/keyword-mentions, data/top-mentions, etc.)
// are available via the same client pattern — add them when needed.

import { kvGet, kvSet } from "./db";

const ELFA_API = "https://api.elfa.ai";
const API_KEY = process.env.ELFA_API_KEY;

// Soft cap below the hard 1000/day limit so we never trip the actual
// limit and lock ourselves out for the day.
const DAILY_SOFT_CAP = parseInt(process.env.ELFA_DAILY_SOFT_CAP || "950", 10);

// 60 RPM = one request per second sustained. We give ourselves a small
// burst (5) so back-to-back endpoint hits in a single route are fine.
const RATE_PER_SEC = 1;
const RATE_BURST = 5;

let tokens = RATE_BURST;
let lastRefill = Date.now();
const waitQueue: Array<() => void> = [];

function refillTokens(): void {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  if (elapsed <= 0) return;
  tokens = Math.min(RATE_BURST, tokens + elapsed * RATE_PER_SEC);
  lastRefill = now;
}

let drainTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDrain(): void {
  if (drainTimer || waitQueue.length === 0) return;
  const missing = Math.max(0, 1 - tokens);
  const waitMs = Math.ceil((missing / RATE_PER_SEC) * 1000);
  drainTimer = setTimeout(() => {
    drainTimer = null;
    refillTokens();
    while (tokens >= 1 && waitQueue.length > 0) {
      tokens -= 1;
      waitQueue.shift()!();
    }
    if (waitQueue.length > 0) scheduleDrain();
  }, Math.max(10, waitMs));
}

async function acquireToken(): Promise<void> {
  refillTokens();
  if (tokens >= 1) { tokens -= 1; return; }
  await new Promise<void>((resolve) => {
    waitQueue.push(resolve);
    scheduleDrain();
  });
}

// ── Daily budget tracker ────────────────────────────────────────────────
// We persist a counter keyed by the UTC date. Elfa's "daily" window may
// reset on a different schedule, but UTC midnight is a safe over-
// approximation: we never UNDER-count, so if anything we'll refuse
// slightly early. Better than burning the actual hard cap.

function todayKey(): string {
  const d = new Date();
  // YYYY-MM-DD in UTC
  return `elfa_credits:${d.toISOString().slice(0, 10)}`;
}

function getDailyCount(): number {
  const v = kvGet(todayKey());
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function incDailyCount(): void {
  const next = getDailyCount() + 1;
  kvSet(todayKey(), String(next));
}

let totalRequests = 0;
let totalRefused = 0;
let totalErrors = 0;

export function isElfaConfigured(): boolean {
  return !!API_KEY;
}

export interface ElfaStats {
  configured: boolean;
  dailyUsed: number;
  dailyCap: number;
  totalRequests: number;
  totalRefused: number;
  totalErrors: number;
  tokensAvailable: number;
}

export function getElfaStats(): ElfaStats {
  refillTokens();
  return {
    configured: isElfaConfigured(),
    dailyUsed: getDailyCount(),
    dailyCap: DAILY_SOFT_CAP,
    totalRequests,
    totalRefused,
    totalErrors,
    tokensAvailable: Math.floor(tokens),
  };
}

// ── Core fetch ──────────────────────────────────────────────────────────

class ElfaBudgetError extends Error {
  constructor(used: number, cap: number) {
    super(`Elfa daily budget exhausted (${used}/${cap} used)`);
    this.name = "ElfaBudgetError";
  }
}

class ElfaNotConfiguredError extends Error {
  constructor() {
    super("ELFA_API_KEY not set");
    this.name = "ElfaNotConfiguredError";
  }
}

async function elfaGet<T>(path: string, costsCredit: boolean = true): Promise<T> {
  if (!API_KEY) throw new ElfaNotConfiguredError();
  if (costsCredit) {
    const used = getDailyCount();
    if (used >= DAILY_SOFT_CAP) {
      totalRefused += 1;
      throw new ElfaBudgetError(used, DAILY_SOFT_CAP);
    }
  }

  await acquireToken();
  totalRequests += 1;

  const url = `${ELFA_API}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-elfa-api-key": API_KEY,
        Accept: "application/json",
      },
      // Always bypass Next.js fetch cache — we own caching at the route
      // layer (SQLite + in-memory TTLCache).
      cache: "no-store",
    });
    // Elfa counts 4xx (e.g. invalid params) against the daily quota too,
    // so we increment the counter on any HTTP response that isn't an
    // auth rejection or transport failure. 401/403 imply the request
    // never reached the metered tier — leave them uncounted.
    if (res.status === 401 || res.status === 403) {
      totalErrors += 1;
      throw new Error(`Elfa auth failed (${res.status}). Check ELFA_API_KEY.`);
    }
    if (res.status === 429) {
      totalErrors += 1;
      tokens = 0;
      lastRefill = Date.now();
      // 429 does count (request was processed up to the rate-limit gate).
      if (costsCredit) incDailyCount();
      throw new Error("Elfa rate limited (429)");
    }
    if (!res.ok) {
      totalErrors += 1;
      // 4xx + 5xx — Elfa charges. Bump the counter before throwing so
      // our soft-cap detection stays accurate.
      if (costsCredit) incDailyCount();
      throw new Error(`Elfa API error: ${res.status}`);
    }
    const json = (await res.json()) as { success?: boolean; data?: T; error?: string };
    if (json.success === false) {
      totalErrors += 1;
      throw new Error(`Elfa API error: ${json.error ?? "unknown"}`);
    }
    // 2xx path — also increment if we didn't already on a 4xx branch.
    if (costsCredit) incDailyCount();
    return (json.data ?? json) as T;
  } catch (err) {
    // Don't double-count budget errors as errors — they're a deliberate
    // refusal, not an upstream fault.
    if (!(err instanceof ElfaBudgetError) && !(err instanceof ElfaNotConfiguredError)) {
      // We already incremented totalErrors above on the known branches;
      // network-layer failures land here and need counting too.
      if (!(err instanceof Error) || !err.message.includes("Elfa")) {
        totalErrors += 1;
      }
    }
    throw err;
  }
}

// ── Endpoints ───────────────────────────────────────────────────────────

export interface TrendingToken {
  token: string;            // lowercase from Elfa
  current_count: number;
  previous_count: number;
  change_percent: number;
}

export interface TrendingTokensResponse {
  total: number;
  page: number;
  pageSize: number;
  data: TrendingToken[];
}

export type TrendingTimeWindow = "1h" | "4h" | "12h" | "24h" | "7d";

// One call returns mindshare for up to `pageSize` tokens. We use this
// instead of per-symbol lookups because it amortises to ~1 credit/hour
// for the entire universe (vs ~40 credits/hour if we polled per asset).
export async function getTrendingTokens(opts: {
  timeWindow?: TrendingTimeWindow;
  pageSize?: number;
  minMentions?: number;
} = {}): Promise<TrendingTokensResponse> {
  const params = new URLSearchParams();
  params.set("timeWindow", opts.timeWindow ?? "24h");
  // Elfa caps pageSize at 100 (returns 400 above that). 100 is enough to
  // cover BTC/ETH/HYPE + all top alts that have any meaningful mention
  // volume in a 24h window — past 100 the long tail is < 10 mentions/day.
  const ps = Math.min(100, Math.max(1, opts.pageSize ?? 100));
  params.set("pageSize", String(ps));
  if (opts.minMentions !== undefined) params.set("minMentions", String(opts.minMentions));
  return elfaGet<TrendingTokensResponse>(`/v2/aggregations/trending-tokens?${params}`);
}

// Free — does not count against the daily quota. Use for ops/diagnostic.
export async function getKeyStatus(): Promise<unknown> {
  return elfaGet(`/v2/key-status`, /* costsCredit */ false);
}

export { ElfaBudgetError, ElfaNotConfiguredError };

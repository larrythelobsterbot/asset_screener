import { NextRequest, NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import {
  getTrendingTokens,
  isElfaConfigured,
  getElfaStats,
  ElfaBudgetError,
  type TrendingTimeWindow,
} from "@/lib/elfa";
import { insertSocialSnapshots, latestSocialSnapshots } from "@/lib/db";

// Aggregated social mindshare for the universe of trending crypto symbols.
//
// Budget model:
//   - One Elfa call returns up to 200 symbols with mention counts.
//   - In-memory cache TTL = 60 minutes per (timeWindow).
//   - SQLite persists the snapshot so cold-start (post-PM2-restart)
//     serves the last hour's data without a fresh Elfa call.
//   - Daily soft cap (default 950/1000) enforced in the Elfa client.
//
// Worst-case burn: 24 calls/day per timeWindow. We expose only 24h by
// default to avoid users casually switching tf= and racking up calls.

export const dynamic = "force-dynamic";

const VALID_TFS: TrendingTimeWindow[] = ["1h", "4h", "12h", "24h", "7d"];
const ROUTE_CACHE_TTL_MS = 60 * 60_000;   // 1 hour
const SQLITE_FRESH_MS = 60 * 60_000;       // accept snapshots up to 1h old

interface SocialRow {
  symbol: string;          // UPPERCASE (matches the rest of our codebase)
  mention_count: number;
  prev_count: number | null;
  change_pct: number | null;
}

export interface SocialResponse {
  generated_at: number;
  source: "elfa" | "sqlite" | "cache";
  timeWindow: TrendingTimeWindow;
  count: number;
  budget: {
    daily_used: number;
    daily_cap: number;
  };
  data: SocialRow[];
}

function normalize(token: string): string {
  return token.toUpperCase();
}

export async function GET(req: NextRequest) {
  if (!isElfaConfigured()) {
    return NextResponse.json(
      { error: "Elfa not configured", hint: "set ELFA_API_KEY in .env.local" },
      { status: 503 }
    );
  }

  const tfParam = req.nextUrl.searchParams.get("tf") ?? "24h";
  if (!VALID_TFS.includes(tfParam as TrendingTimeWindow)) {
    return NextResponse.json(
      { error: `invalid tf "${tfParam}" — expected one of ${VALID_TFS.join("|")}` },
      { status: 400 }
    );
  }
  const tf = tfParam as TrendingTimeWindow;

  const cacheKey = `api:social:trending:${tf}`;
  const cached = cache.get<SocialResponse>(cacheKey);
  if (cached) return NextResponse.json(cached);

  const now = Date.now();

  // L2: SQLite. If the most recent snapshot for THIS time_window is
  // < 1h old, return it without burning a credit. The time_window
  // scoping (added in v5) means a 24h snapshot won't be served for a
  // 1h request — earlier versions confused these and returned wrong
  // data to the UI.
  const recent = latestSocialSnapshots(tf);
  if (recent.size > 0) {
    let newestTs = 0;
    for (const r of recent.values()) if (r.ts > newestTs) newestTs = r.ts;
    if (now - newestTs < SQLITE_FRESH_MS) {
      const data: SocialRow[] = [...recent.values()].map((r) => ({
        symbol: r.symbol,
        mention_count: r.mention_count,
        prev_count: r.prev_count,
        change_pct: r.change_pct,
      }));
      const body: SocialResponse = {
        generated_at: newestTs,
        source: "sqlite",
        timeWindow: tf,
        count: data.length,
        budget: { daily_used: getElfaStats().dailyUsed, daily_cap: getElfaStats().dailyCap },
        data,
      };
      cache.set(cacheKey, body, ROUTE_CACHE_TTL_MS - (now - newestTs));
      return NextResponse.json(body);
    }
  }

  // L3: hit Elfa.
  try {
    const resp = await getTrendingTokens({ timeWindow: tf, pageSize: 100 });
    const ts = Date.now();
    const rows = resp.data.map((t) => ({
      symbol: normalize(t.token),
      time_window: tf,
      ts,
      mention_count: t.current_count,
      prev_count: t.previous_count ?? null,
      change_pct: t.change_percent ?? null,
    }));
    try {
      insertSocialSnapshots(rows);
    } catch (err) {
      console.warn(`[social] sqlite write failed:`, err);
    }
    const stats = getElfaStats();
    const body: SocialResponse = {
      generated_at: ts,
      source: "elfa",
      timeWindow: tf,
      count: rows.length,
      budget: { daily_used: stats.dailyUsed, daily_cap: stats.dailyCap },
      data: rows.map((r) => ({
        symbol: r.symbol,
        mention_count: r.mention_count,
        prev_count: r.prev_count,
        change_pct: r.change_pct,
      })),
    };
    cache.set(cacheKey, body, ROUTE_CACHE_TTL_MS);
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof ElfaBudgetError) {
      // Budget exhausted — try to serve a stale SQLite snapshot if any,
      // otherwise tell the client we're rate-locked for the day.
      if (recent.size > 0) {
        const data: SocialRow[] = [...recent.values()].map((r) => ({
          symbol: r.symbol,
          mention_count: r.mention_count,
          prev_count: r.prev_count,
          change_pct: r.change_pct,
        }));
        return NextResponse.json({
          generated_at: Math.max(...[...recent.values()].map((r) => r.ts)),
          source: "sqlite" as const,
          timeWindow: tf,
          count: data.length,
          budget: { daily_used: getElfaStats().dailyUsed, daily_cap: getElfaStats().dailyCap },
          data,
          note: "daily budget exhausted — serving stale snapshot",
        });
      }
      return NextResponse.json(
        { error: err.message, budget: { daily_used: getElfaStats().dailyUsed, daily_cap: getElfaStats().dailyCap } },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

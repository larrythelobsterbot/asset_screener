import { NextResponse } from "next/server";
import { cache } from "@/lib/cache";
import { listFeedEvents, type FeedEventRow } from "@/lib/db";
import { startTreeNewsPoller } from "@/lib/treeNews";
import { startTreeNewsWs } from "@/lib/treeNewsWs";

// Boot both Tree News transports alongside the route. Idempotent —
// repeated imports won't double-schedule. The authed websocket is the
// primary real-time push; the REST poller is a 30s backfill for
// reconnect gaps. Both write feed_events (deduped by _id); this route is
// the read surface the /terminal page polls.
startTreeNewsWs();
startTreeNewsPoller();

export const dynamic = "force-dynamic";

// Short cache so a burst of clients between polls shares one DB read.
// Keyed by the full query so symbol/source filters don't collide.
const ROUTE_CACHE_TTL_MS = 5_000;

export interface FeedItem {
  id: number;
  ts: number;
  source: string;
  author: string | null;
  title: string;
  body: string | null;
  url: string | null;
  symbols: string[];
  importance: number;
}

function toItem(r: FeedEventRow): FeedItem {
  let symbols: string[] = [];
  if (r.symbols_json) {
    try { symbols = JSON.parse(r.symbols_json); } catch { /* leave empty */ }
  }
  return {
    id: r.id,
    ts: r.ts,
    source: r.source,
    author: r.author,
    title: r.title,
    body: r.body,
    url: r.url,
    symbols,
    importance: r.importance,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source") || undefined;
  const symbol = url.searchParams.get("symbol") || undefined;
  const sinceRaw = url.searchParams.get("since");
  const minImpRaw = url.searchParams.get("minImportance");
  const limitRaw = url.searchParams.get("limit");

  const since = sinceRaw != null && Number.isFinite(+sinceRaw) ? +sinceRaw : undefined;
  const minImportance = minImpRaw != null && Number.isFinite(+minImpRaw) ? +minImpRaw : undefined;
  const limit = limitRaw != null && Number.isFinite(+limitRaw) ? +limitRaw : undefined;

  const cacheKey = `api:feed:${url.search}`;
  const cached = cache.get<FeedItem[]>(cacheKey);
  if (cached) return NextResponse.json({ items: cached });

  const rows = listFeedEvents({ source, symbol, minImportance, since, limit });
  const items = rows.map(toItem);
  cache.set(cacheKey, items, ROUTE_CACHE_TTL_MS);
  return NextResponse.json({ items });
}

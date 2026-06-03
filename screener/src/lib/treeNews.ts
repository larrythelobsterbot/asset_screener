// Tree of Alpha news ingestion.
//
// Tree of Alpha aggregates hundreds of curated crypto-Twitter accounts,
// exchange listing announcements, and news outlets into one stream. For
// a day-trader the actionable items are LISTINGS, HACKS, ETF/regulatory
// headlines and macro prints — `importance: 2` flags those.
//
// We POLL the public REST endpoint (`/api/news`) rather than the
// websocket: the REST shape is stable and verified, dedup by Tree's
// native `_id` makes re-polling idempotent, and a 12s cadence is plenty
// for v1. The seam to upgrade to the websocket (or the paid low-latency
// socket) is `fetchRecentNews()` — swap the transport, keep the
// normalisation + insert path. Mirrors the start*Poller pattern used by
// hypePressurePoller / startHlWs: idempotent boot, setInterval, unref.

import { fetchWithTimeout } from "./fetchWithTimeout";
import { insertFeedEvents, type FeedEventInput } from "./db";
import { HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP } from "@/config/sectors";

const NEWS_URL = "https://news.treeofalpha.com/api/news?limit=30";
// Backfill cadence. The authed websocket (treeNewsWs.ts) is the primary,
// real-time transport; this REST poll exists to catch anything missed
// during WS reconnect windows and to seed history on cold start. Dedup by
// `_id` makes the overlap a no-op, so a relaxed 30s is plenty.
const POLL_INTERVAL_MS = 30_000;
const SOURCE = "tree";

// The set of tickers we actually trade — used to (a) tag feed rows with
// matched symbols and (b) bump importance when a headline names one of
// our perps. Built once from the perp sector maps. Bare uppercase, e.g.
// "BTC", "HYPE".
const TRACKED: Set<string> = new Set([
  ...Object.keys(HL_PERP_SECTOR_MAP),
  ...Object.keys(HL_BUILDER_PERP_MAP),
].map((s) => s.toUpperCase()));

// Market-moving keyword → importance 2. These are the headlines that
// reprice an asset within minutes. Broader "notable" (importance 1) is
// inferred from a tracked-symbol match instead. For a headline trader,
// missing a listing is worse than over-tagging, so the listing vocabulary
// is deliberately generous (audit finding M6).
const MOVING_RE = new RegExp(
  "\\b(" + [
    // listings / delistings / new contracts
    "listing", "will list", "to list", "lists", "listed on",
    "delist\\w*", "launchpool", "launchpad",
    "perpetual (?:contract|futures)", "perp(?:etual)? listing",
    "futures? (?:listing|contract)", "spot (?:listing|trading pair)",
    "adds? (?:spot|perpetual|futures|support for)", "support for",
    "trading (?:will )?(?:open|go(?:es)? live|begins)", "now (?:listed|trading|available)",
    "pre-?market",
    // exploits / security
    "hack(?:ed|s)?", "exploit\\w*", "drained?", "breach", "rug",
    // halts / regulatory / macro
    "halt(?:ed|s|ing)?", "etf", "\\bsec\\b", "lawsuit", "indict\\w*",
    "fomc", "\\bcpi\\b", "rate (?:cut|hike|decision)", "approv\\w*",
    // supply events
    "token unlock", "unlock", "airdrop", "snapshot",
  ].join("|") + ")\\b",
  "i"
);

// Only http(s) URLs are safe to render as a link target. A compromised or
// future source (Telegram/Twitter) could emit `javascript:`/`data:` etc.;
// we drop anything that isn't http/https at ingest so the UI never renders
// an unsafe href (audit finding H1).
function sanitizeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? raw : null;
  } catch {
    return null;
  }
}

// ── Tree shape (verified against /api/news; the WS pushes the same
// objects, plus a `{user}` login-ack which the WS client filters out) ───
interface TreeSuggestion {
  coin?: string;
  found?: string[];
  symbols?: { exchange: string; symbol: string }[];
}
export interface TreeNewsItem {
  _id?: string;
  title?: string;
  en?: string;
  body?: string;
  source?: string;       // "Blogs" | "Twitter" | "Binance Announcements" | ...
  sourceName?: string;   // "COINTELEGRAPH" | account handle | ...
  url?: string;
  link?: string;
  time?: number;         // ms epoch
  symbols?: string[];
  suggestions?: TreeSuggestion[];
}

// Extract bare uppercase tickers that we actually trade. Primary source
// is Tree's own coin suggestions (high quality); we intersect with our
// universe so the UI filter only ever sees symbols that exist here.
function matchedSymbols(item: TreeNewsItem): string[] {
  const out = new Set<string>();
  for (const sug of item.suggestions ?? []) {
    const c = sug.coin?.toUpperCase();
    if (c && TRACKED.has(c)) out.add(c);
  }
  return [...out];
}

function classifyImportance(title: string, symbols: string[]): number {
  if (MOVING_RE.test(title)) return 2;
  if (symbols.length > 0) return 1;
  return 0;
}

// Exported so the websocket client (treeNewsWs.ts) normalises pushed
// items through the exact same path as the REST poller — one schema,
// one importance heuristic, one dedup_key scheme.
export function normalizeTreeItem(item: TreeNewsItem): FeedEventInput | null {
  const id = item._id;
  const title = (item.title || item.en || "").trim();
  if (!id || !title) return null; // can't dedup / nothing to show
  const ts = Number.isFinite(item.time) ? (item.time as number) : Date.now();
  const symbols = matchedSymbols(item);
  return {
    ts,
    source: SOURCE,
    author: item.sourceName || item.source || null,
    title,
    body: item.body?.trim() || null,
    url: sanitizeUrl(item.url || item.link),
    symbols_json: symbols.length ? JSON.stringify(symbols) : null,
    importance: classifyImportance(title, symbols),
    dedup_key: `${SOURCE}:${id}`,
    raw_json: null, // keep the table lean; re-derive from source if ever needed
  };
}

// Fetch + normalize the recent news window. Exported so it can be unit
// tested and so a future websocket transport can reuse the normaliser.
export async function fetchRecentNews(): Promise<FeedEventInput[]> {
  const res = await fetchWithTimeout(NEWS_URL, {
    headers: { accept: "application/json" },
  }, 10_000);
  if (!res.ok) throw new Error(`tree news ${res.status}`);
  const json = (await res.json()) as TreeNewsItem[];
  if (!Array.isArray(json)) throw new Error("tree news: expected array");
  const rows: FeedEventInput[] = [];
  for (const item of json) {
    const row = normalizeTreeItem(item);
    if (row) rows.push(row);
  }
  return rows;
}

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let consecutiveErrors = 0;
let totalInserted = 0;

async function runOnce(): Promise<void> {
  try {
    const rows = await fetchRecentNews();
    const inserted = insertFeedEvents(rows);
    totalInserted += inserted;
    consecutiveErrors = 0;
    lastError = null;
    if (inserted > 0) {
      console.info(`[tree-news] +${inserted} new (of ${rows.length} fetched)`);
    }
  } catch (err) {
    consecutiveErrors += 1;
    lastError = String(err);
    // Log first failure then every 10th — don't drown logs during a Tree
    // outage. Same discipline as hypePressurePoller.
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      console.warn(`[tree-news] poll #${consecutiveErrors} failed:`, lastError);
    }
  }
}

export function startTreeNewsPoller(): void {
  if (started) return;
  started = true;
  runOnce();
  timer = setInterval(runOnce, POLL_INTERVAL_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
}

export function getTreeNewsStats(): {
  started: boolean;
  consecutiveErrors: number;
  lastError: string | null;
  totalInserted: number;
} {
  return { started, consecutiveErrors, lastError, totalInserted };
}

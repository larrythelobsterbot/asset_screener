// Tree of Alpha authenticated news websocket — the primary, real-time
// transport for the catalyst feed. Mirrors hyperliquidWs.ts: one
// process-wide connection, auto-reconnect with exponential backoff,
// Node-22+ global WebSocket (no new dependency).
//
// Protocol (verified):
//   1. connect to wss://news.treeofalpha.com/ws
//   2. on open, send the plain-text frame `login <API_KEY>`
//   3. server replies once with a login ack: { time, user: {...} }
//   4. thereafter it PUSHES news objects — same shape as the REST
//      /api/news items — which we normalise + insert (deduped by _id,
//      so overlap with the REST backfill poller is harmless).
//
// NOTE on latency: Tree only removes the feed delay for Sprout/Sapling/NFT
// subscribers. If the login ack shows isSub=false the pushed items still
// carry the free-tier delay — but push delivery still beats polling, and
// upgrading the Tree sub later requires zero code change here.

import { insertFeedEvents } from "./db";
import { normalizeTreeItem, type TreeNewsItem } from "./treeNews";

const WS_URL = "wss://news.treeofalpha.com/ws";
const MAX_BACKOFF_MS = 30_000;

interface LoginAck {
  time: number;
  user?: { username?: string; isSub?: boolean; highestRole?: number };
}

let ws: WebSocket | null = null;
let started = false;
let reconnectAttempt = 0;
let authed = false;
let authUser: string | null = null;
let isSub: boolean | null = null;
let totalInserted = 0;
let totalMessages = 0;
let lastMessageTs = 0;

function getKey(): string | undefined {
  return process.env.TREE_NEWS_API_KEY;
}

function scheduleReconnect(): void {
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, reconnectAttempt));
  reconnectAttempt += 1;
  setTimeout(connect, backoff);
}

function handleNewsItem(item: TreeNewsItem): void {
  const row = normalizeTreeItem(item);
  if (!row) return;
  try {
    totalInserted += insertFeedEvents([row]);
  } catch (err) {
    console.warn("[tree-ws] insert failed:", err);
  }
}

function connect(): void {
  if (typeof WebSocket === "undefined") {
    console.error("[tree-ws] no global WebSocket — node < 22? aborting");
    return;
  }
  const key = getKey();
  if (!key) return; // no key → WS disabled; REST poller still runs

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn("[tree-ws] construct failed:", err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    authed = false;
    ws!.send(`login ${key}`);
    console.info("[tree-ws] connected, sent login");
  });

  ws.addEventListener("message", (event) => {
    totalMessages += 1;
    lastMessageTs = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return; // non-JSON frame — ignore
    }
    if (typeof parsed !== "object" || parsed === null) return;

    // Login ack carries a `user` object and no `_id`/`title`. Capture the
    // auth state for diagnostics; don't treat it as a news item.
    const obj = parsed as Record<string, unknown>;
    if (obj.user && !obj._id && !obj.title) {
      const ack = parsed as LoginAck;
      authed = true;
      authUser = ack.user?.username ?? null;
      isSub = ack.user?.isSub ?? null;
      console.info(
        `[tree-ws] authed as ${authUser ?? "?"} (isSub=${isSub}) — ` +
        `${isSub ? "low-latency feed" : "free-tier delay still applies"}`
      );
      return;
    }

    // Some feeds wrap a batch in an array; handle both single + array.
    if (Array.isArray(parsed)) {
      for (const it of parsed) handleNewsItem(it as TreeNewsItem);
    } else if (obj._id || obj.title) {
      handleNewsItem(parsed as TreeNewsItem);
    }
  });

  ws.addEventListener("close", (event) => {
    console.warn(`[tree-ws] closed (code=${event.code}); reconnecting`);
    ws = null;
    authed = false;
    scheduleReconnect();
  });

  ws.addEventListener("error", (event) => {
    console.warn("[tree-ws] error:", (event as ErrorEvent).message ?? "(no detail)");
  });
}

// Idempotent boot. No-op if there's no API key (REST poller covers that
// case). Call alongside startTreeNewsPoller().
export function startTreeNewsWs(): void {
  if (started) return;
  started = true;
  if (!getKey()) {
    console.info("[tree-ws] no TREE_NEWS_API_KEY — websocket disabled, using REST poll only");
    return;
  }
  connect();
}

export function getTreeNewsWsStats(): {
  started: boolean;
  connected: boolean;
  authed: boolean;
  authUser: string | null;
  isSub: boolean | null;
  totalMessages: number;
  totalInserted: number;
  msSinceLastMessage: number;
  reconnectAttempts: number;
} {
  return {
    started,
    connected: ws?.readyState === 1,
    authed,
    authUser,
    isSub,
    totalMessages,
    totalInserted,
    msSinceLastMessage: lastMessageTs ? Date.now() - lastMessageTs : Infinity,
    reconnectAttempts: reconnectAttempt,
  };
}

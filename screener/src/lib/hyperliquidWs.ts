// Hyperliquid WebSocket client for real-time mid prices.
//
// One process-wide WebSocket subscribing to the `allMids` channel. Updates
// land in an in-memory Map<symbol, {mid, ts}> that API routes read on
// demand. This lets us replace 30s REST polling latency with sub-second
// freshness without adding any new dependency — Node 22+ has a global
// WebSocket implementation matching the browser API.
//
// We deliberately don't write WS updates to SQLite. At 230 symbols
// × ~10 updates/sec the row volume would dominate the `price_snapshots`
// table without adding analytical value (the per-scan snapshot already
// captures the cadence we care about for back-testing).
//
// Failure modes handled:
// - Connection refused / TCP error: log + reconnect with exponential backoff
// - Idle close (HL drops the connection): same — reconnect
// - Receiving a message before subscribe handshake completes: ignored
// - "Stale" mid (clock skew or symbol went silent): getMid() returns null
//   after STALE_MS so callers don't show prices that haven't ticked in
//   a long time.

const WS_URL = "wss://api.hyperliquid.xyz/ws";

// If a symbol's mid hasn't updated in this window, treat it as stale and
// let callers fall back to the REST mark price. 60s is conservative —
// active perps tick many times per second; a 60s gap means the WS lost
// the symbol, not that the market is quiet.
const STALE_MS = 60_000;

// Cap reconnect backoff at 30s. Linear ramp would hammer HL on a full
// outage; pure exponential could mean an hour between retries after
// several failures. 30s is a good middle.
const MAX_BACKOFF_MS = 30_000;

interface MidEntry {
  mid: number;
  ts: number;
}

let ws: WebSocket | null = null;
const mids: Map<string, MidEntry> = new Map();
let reconnectAttempt = 0;
let connectionStartTs = 0;
let lastMessageTs = 0;
let totalMessages = 0;
let totalUpdates = 0;
let started = false;

function scheduleReconnect(): void {
  const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, reconnectAttempt));
  reconnectAttempt += 1;
  setTimeout(connect, backoff);
}

function connect(): void {
  // Node 22+ provides WebSocket as a global; we expect this to exist in
  // the production runtime. If it doesn't, fail loudly at startup rather
  // than silently degrade — that surface should never quietly miss.
  if (typeof WebSocket === "undefined") {
    console.error("[hl-ws] no global WebSocket — node < 22? aborting WS init");
    return;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    console.warn("[hl-ws] construct failed:", err);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    connectionStartTs = Date.now();
    // Subscribe to the allMids channel. After this, HL sends a snapshot
    // of all current mids plus a stream of updates.
    ws!.send(
      JSON.stringify({
        method: "subscribe",
        subscription: { type: "allMids" },
      })
    );
    console.info("[hl-ws] connected, subscribed to allMids");
  });

  ws.addEventListener("message", (event) => {
    totalMessages += 1;
    lastMessageTs = Date.now();
    // event.data is string for text frames per the WHATWG spec; HL only
    // sends JSON text frames on this channel.
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data as string);
    } catch {
      return; // malformed frame — drop it
    }
    // Shape: { channel: "allMids", data: { mids: { BTC: "65000.5", ... } } }
    if (
      typeof parsed !== "object" || parsed === null ||
      (parsed as { channel?: string }).channel !== "allMids"
    ) return;
    const data = (parsed as { data?: { mids?: Record<string, string> } }).data;
    if (!data?.mids) return;
    const now = Date.now();
    for (const [sym, raw] of Object.entries(data.mids)) {
      const num = parseFloat(raw);
      if (Number.isFinite(num) && num > 0) {
        mids.set(sym, { mid: num, ts: now });
        totalUpdates += 1;
      }
    }
  });

  ws.addEventListener("close", (event) => {
    console.warn(`[hl-ws] closed (code=${event.code}, reason="${event.reason}"); reconnecting`);
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", (event) => {
    // The WHATWG WebSocket error event doesn't carry useful detail —
    // the actual reason surfaces in the close event that follows.
    console.warn("[hl-ws] error event:", (event as ErrorEvent).message ?? "(no detail)");
  });
}

// Public init — idempotent. Call once on process boot. Subsequent calls
// are no-ops so it's safe to scatter `startHlWs()` next to other startup
// hooks (e.g. startPruneJob).
export function startHlWs(): void {
  if (started) return;
  started = true;
  connect();
}

// Returns the latest live mid for a symbol, or null if we don't have one
// or it's gone stale. Callers should fall back to whatever REST source
// they normally use when this returns null.
export function getMid(symbol: string): number | null {
  const entry = mids.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.ts > STALE_MS) return null;
  return entry.mid;
}

// Snapshot of the entire live mid map. Callers should not mutate the
// returned object — it shares the underlying entries with the live map.
// Caller can filter by staleness using the ts field.
export function getAllLiveMids(): Map<string, MidEntry> {
  return mids;
}

export interface WsStats {
  connected: boolean;
  symbolCount: number;
  totalMessages: number;
  totalUpdates: number;
  connectionAgeMs: number;
  msSinceLastMessage: number;
  reconnectAttempts: number;
}

export function getWsStats(): WsStats {
  return {
    connected: ws?.readyState === 1, // 1 === OPEN; literal avoids polyfill mismatches
    symbolCount: mids.size,
    totalMessages,
    totalUpdates,
    connectionAgeMs: connectionStartTs ? Date.now() - connectionStartTs : 0,
    msSinceLastMessage: lastMessageTs ? Date.now() - lastMessageTs : Infinity,
    reconnectAttempts: reconnectAttempt,
  };
}

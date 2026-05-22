// Background poller for HYPE TWAP buy-pressure.
//
// Runs every POLL_INTERVAL_MS:
//   1. Read latest HYPE mid from the WS client (no network call)
//   2. Fetch + compute pressure from hypurrscan (60s cache there)
//   3. Persist snapshot to SQLite
//   4. If pressure_1h_usd crosses the threshold (default $1M), fire a
//      Telegram alert — with a cooldown so we don't spam while it stays
//      above the line.
//
// Idempotent startup: callers fire `startHypePressurePoller()` from
// wherever; subsequent calls are no-ops. Same pattern as startPruneJob /
// startHlWs.

import { getMid } from "./hyperliquidWs";
import { getHypePressure } from "./hypurrscan";
import { insertHypePressureSnapshot, kvGet, kvSet } from "./db";
import { sendTelegramMessage, isTelegramConfigured } from "./telegram";

const POLL_INTERVAL_MS = 90_000;        // 90s — comfortably under hypurrscan's anon limit
const ALERT_THRESHOLD_USD = parseFloat(
  process.env.HYPE_PRESSURE_ALERT_THRESHOLD_USD || "1000000"
);
// One alert per hour while above the threshold. Prevents spam if
// pressure sits above $1M for an extended period.
const ALERT_COOLDOWN_MS = 60 * 60_000;
const COOLDOWN_KV_KEY = "hype_pressure_alert_last_ts";

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let consecutiveErrors = 0;

function isOnAlertCooldown(now: number): boolean {
  const last = kvGet(COOLDOWN_KV_KEY);
  if (!last) return false;
  const lastMs = parseInt(last, 10);
  if (!Number.isFinite(lastMs)) return false;
  return now - lastMs < ALERT_COOLDOWN_MS;
}

function fmtUsd(n: number): string {
  // Match the screenshot's formatting: `$X,XXX,XXX$` (the trailing $ is
  // a Hypurrscan-ism; we use the more conventional `$X,XXX,XXX` instead).
  const sign = n >= 0 ? "+" : "−";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

async function maybeAlertOnThreshold(
  pressure1h: number,
  pressure24h: number,
  hypePrice: number,
  twapCount: number,
  now: number
): Promise<void> {
  if (!isTelegramConfigured()) return;
  if (pressure1h < ALERT_THRESHOLD_USD) return;
  if (isOnAlertCooldown(now)) return;

  // Stamp cooldown BEFORE sending so concurrent polls (shouldn't happen
  // with our setInterval but defensive) can't double-fire. On send
  // failure we rewind to "5 min from now" so the next poller tick gets
  // a retry attempt — without this, a transient Telegram outage would
  // silently lose the alert for the full 1h cooldown window.
  kvSet(COOLDOWN_KV_KEY, String(now));

  const text = [
    `🟢 <b>HYPE TWAP Buy Pressure</b>`,
    ``,
    `Next 1h: <b>${fmtUsd(pressure1h)}</b>  ← over $1M threshold`,
    `Next 24h: ${fmtUsd(pressure24h)}`,
    ``,
    `HYPE: <code>$${hypePrice.toFixed(4)}</code> · ${twapCount} active TWAPs`,
    ``,
    `<a href="https://hypurrscan.io/dashboard">hypurrscan dashboard</a>`,
  ].join("\n");

  const r = await sendTelegramMessage(text);
  if (!r.ok) {
    console.warn(`[hype-pressure] alert send failed:`, r.error);
    // Rewind cooldown: a value that expires in ~5 min so the next tick
    // (90s cadence) gets up to 3 retry attempts before the threshold
    // moves out of play.
    kvSet(COOLDOWN_KV_KEY, String(now - ALERT_COOLDOWN_MS + 5 * 60_000));
  } else {
    console.info(
      `[hype-pressure] ALERT fired: 1h=$${pressure1h.toLocaleString()} ` +
      `(threshold $${ALERT_THRESHOLD_USD.toLocaleString()})`
    );
  }
}

async function runOnce(): Promise<void> {
  const hypePrice = getMid("HYPE");
  if (hypePrice == null) {
    // WS not connected yet, or HYPE mid hasn't ticked. Skip this round —
    // we'll catch it next interval. Don't log on every miss because
    // boot-up will see a few of these.
    return;
  }
  try {
    const p = await getHypePressure(hypePrice);
    const now = Date.now();
    insertHypePressureSnapshot({
      ts: now,
      pressure_1h_usd: p.pressure_1h_usd,
      pressure_24h_usd: p.pressure_24h_usd,
      hype_price: p.hype_price,
      active_twap_count: p.active_twap_count,
    });
    consecutiveErrors = 0;
    lastError = null;
    await maybeAlertOnThreshold(
      p.pressure_1h_usd, p.pressure_24h_usd, p.hype_price, p.active_twap_count, now
    );
  } catch (err) {
    consecutiveErrors += 1;
    lastError = String(err);
    // First failure: log. Subsequent: log every 10th to avoid drowning
    // logs during a hypurrscan outage.
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      console.warn(`[hype-pressure] poll #${consecutiveErrors} failed:`, lastError);
    }
  }
}

export function startHypePressurePoller(): void {
  if (started) return;
  started = true;
  // First run is delayed slightly so the WS has a chance to populate
  // the HYPE mid. 5s gives plenty of buffer on a cold start.
  setTimeout(() => {
    runOnce();
    timer = setInterval(runOnce, POLL_INTERVAL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }, 5000);
}

export function getHypePressurePollerStats(): {
  started: boolean;
  consecutiveErrors: number;
  lastError: string | null;
} {
  return { started, consecutiveErrors, lastError };
}

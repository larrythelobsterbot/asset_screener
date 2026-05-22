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
import { insertHypePressureSnapshot, hypePressureSnapshotAt, kvGet, kvSet } from "./db";
import { sendTelegramMessage, isTelegramConfigured } from "./telegram";

const POLL_INTERVAL_MS = 90_000;        // 90s — comfortably under hypurrscan's anon limit
const ALERT_THRESHOLD_USD = parseFloat(
  process.env.HYPE_PRESSURE_ALERT_THRESHOLD_USD || "1000000"
);
// One alert per hour while above the threshold. Prevents spam if
// pressure sits above $1M for an extended period.
const ALERT_COOLDOWN_MS = 60 * 60_000;
const COOLDOWN_KV_KEY = "hype_pressure_alert_last_ts";

// ── Divergence alert (pressure up + price flat) ─────────────────────────
// "Pressure rising rapidly while price is flat" is a leading signal —
// buyers are queueing up but haven't moved the order book yet. Once the
// TWAPs actually execute, price tends to follow.
//
// Trigger criteria (must all hold):
//   - pressure_1h_usd grew by ≥ DIVERGENCE_PRESSURE_DELTA_USD
//   - over a window of DIVERGENCE_WINDOW_MS (default 20 min)
//   - HYPE price moved < DIVERGENCE_PRICE_PCT in absolute terms in the
//     same window
// Separate cooldown from the absolute-threshold alert (they can both
// fire — divergence captures the BUILDUP, threshold captures the
// already-crossed state).
const DIVERGENCE_WINDOW_MS = 20 * 60_000;
const DIVERGENCE_PRESSURE_DELTA_USD = parseFloat(
  process.env.HYPE_DIVERGENCE_PRESSURE_DELTA_USD || "500000"
);
const DIVERGENCE_PRICE_PCT = parseFloat(
  process.env.HYPE_DIVERGENCE_MAX_PRICE_PCT || "0.5"
);
const DIVERGENCE_COOLDOWN_MS = 60 * 60_000;
const DIVERGENCE_COOLDOWN_KEY = "hype_pressure_divergence_last_ts";

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

function isOnDivergenceCooldown(now: number): boolean {
  const last = kvGet(DIVERGENCE_COOLDOWN_KEY);
  if (!last) return false;
  const lastMs = parseInt(last, 10);
  if (!Number.isFinite(lastMs)) return false;
  return now - lastMs < DIVERGENCE_COOLDOWN_MS;
}

// Detects "pressure rising fast, price barely moving" — a leading
// signal that buyers are stacking TWAPs but haven't moved the book yet.
// Once the TWAPs start executing, the imbalance hits the price.
//
// Called AFTER the current snapshot has been persisted, so the lookup
// against `now - WINDOW` finds the historical row directly (rather
// than racing the new write).
async function maybeAlertOnDivergence(
  currentPressure1h: number,
  currentHypePrice: number,
  twapCount: number,
  now: number
): Promise<void> {
  if (!isTelegramConfigured()) return;
  if (isOnDivergenceCooldown(now)) return;

  const prior = hypePressureSnapshotAt(now - DIVERGENCE_WINDOW_MS);
  if (!prior) return; // not enough history yet (cold start)

  const pressureDelta = currentPressure1h - prior.pressure_1h_usd;
  if (pressureDelta < DIVERGENCE_PRESSURE_DELTA_USD) return;

  // Price-flat check. We measure absolute % move — divergence is
  // about lack of price reaction, not direction.
  if (prior.hype_price <= 0) return;
  const pricePct = Math.abs((currentHypePrice - prior.hype_price) / prior.hype_price) * 100;
  if (pricePct >= DIVERGENCE_PRICE_PCT) return;

  const windowMin = Math.round(DIVERGENCE_WINDOW_MS / 60_000);
  const ageMin = Math.round((now - prior.ts) / 60_000);

  kvSet(DIVERGENCE_COOLDOWN_KEY, String(now));

  const text = [
    `⚡ <b>HYPE Pressure Divergence</b>`,
    ``,
    `1h pressure: ${fmtUsd(prior.pressure_1h_usd)} → <b>${fmtUsd(currentPressure1h)}</b>`,
    `(<b>+${fmtUsd(pressureDelta)}</b> in last ${ageMin}min, target window ${windowMin}min)`,
    ``,
    `HYPE price barely moved: <code>$${prior.hype_price.toFixed(4)}</code> → <code>$${currentHypePrice.toFixed(4)}</code> (${pricePct.toFixed(2)}%)`,
    ``,
    `Buyers stacking TWAPs but the order book hasn't absorbed yet —`,
    `price tends to follow once executions hit. ${twapCount} active TWAPs.`,
    ``,
    `<a href="https://hypurrscan.io/dashboard">hypurrscan dashboard</a>`,
  ].join("\n");

  const r = await sendTelegramMessage(text);
  if (!r.ok) {
    console.warn(`[hype-pressure] divergence alert send failed:`, r.error);
    kvSet(DIVERGENCE_COOLDOWN_KEY, String(now - DIVERGENCE_COOLDOWN_MS + 5 * 60_000));
  } else {
    console.info(
      `[hype-pressure] DIVERGENCE fired: +${fmtUsd(pressureDelta)} pressure / ${pricePct.toFixed(2)}% price ` +
      `over ${ageMin}min`
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
    // Divergence runs independently of the threshold — buy pressure
    // can be RISING from $200k → $700k (divergence-worthy) without
    // ever crossing $1M. Both alerts can fire on the same tick (rare
    // but possible — a sustained build that finally crosses).
    await maybeAlertOnDivergence(
      p.pressure_1h_usd, p.hype_price, p.active_twap_count, now
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

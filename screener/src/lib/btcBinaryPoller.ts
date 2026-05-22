// Background poller for the HIP-4 daily BTC binary.
//
// Runs every 60s:
//   1. Look up the currently-active binary contract via outcomeMeta
//   2. Read yes/no mids + BTC mid from our HL WS client (no network)
//   3. Persist the row to btc_binary_snapshots
//
// No Telegram alerting in v1 — the side-panel section already surfaces
// the data. Alerts (e.g. "model probability diverges from market by
// >10%") are a Phase 3 follow-up after we've built up enough snapshots
// to measure whether our model has any signal.

import { getCurrentBtcBinary } from "./btcBinary";
import { insertBtcBinarySnapshot } from "./db";

const POLL_INTERVAL_MS = 60_000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let consecutiveErrors = 0;
let lastError: string | null = null;
let totalSnapshots = 0;

async function runOnce(): Promise<void> {
  try {
    const state = await getCurrentBtcBinary();
    if (!state) {
      // No active binary right now — could be the brief contract
      // rollover at 06:00 UTC, or a deployment issue. Skip cleanly.
      return;
    }
    if (state.yesMid == null || state.noMid == null || state.btcMid == null) {
      // WS hasn't ticked these symbols yet — try next interval.
      return;
    }
    insertBtcBinarySnapshot({
      ts: Date.now(),
      target_price: state.targetPrice,
      expiry_ms: state.expiryMs,
      yes_price: state.yesMid,
      no_price: state.noMid,
      btc_mid: state.btcMid,
    });
    totalSnapshots += 1;
    consecutiveErrors = 0;
    lastError = null;
  } catch (err) {
    consecutiveErrors += 1;
    lastError = String(err);
    // Log on first error and every 10th subsequent — gives one signal
    // immediately + bounded volume during sustained outage.
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      console.warn(`[btc-binary] poll #${consecutiveErrors} failed:`, lastError);
    }
  }
}

export function startBtcBinaryPoller(): void {
  if (started) return;
  started = true;
  // 5s warmup so the WS has populated BTC + outcome mids.
  setTimeout(() => {
    runOnce();
    timer = setInterval(runOnce, POLL_INTERVAL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }, 5000);
}

export function getBtcBinaryPollerStats(): {
  started: boolean;
  totalSnapshots: number;
  consecutiveErrors: number;
  lastError: string | null;
} {
  return { started, totalSnapshots, consecutiveErrors, lastError };
}

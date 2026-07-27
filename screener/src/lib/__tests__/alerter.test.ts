import "./db-test-setup";

// Tests for the trade-card math in alerter.ts.
//
// We don't try to test the Telegram dispatch path here — that has too many
// IO dependencies. Instead we test the pure computeTradeCard() function,
// which is what the alert body composes from.
//
// Env knobs (ALERT_ACCOUNT_USD etc.) are read at module load — these tests
// rely on the defaults. If we ever make them more dynamic, switch to
// importing a factory.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  alertEligibility,
  computeTradeCard,
  deliverTrackedTelegramAlert,
  maybeDispatchAlerts,
  sanitizeTelegramDeliveryError,
} from "../alerter";
import { listAlertCandidates, type NewTelegramAlert } from "../db";
import type { ConvictionResult, Signal } from "../signals";

function conviction(volRegime: ConvictionResult["volRegime"], score = 4): ConvictionResult {
  return {
    score,
    label: score >= 0 ? "Strong Buy" : "Strong Sell",
    bullishCount: score >= 0 ? 2 : 0,
    bearishCount: score < 0 ? 2 : 0,
    contributingFamilies: ["momentum", "trend"],
    volRegime,
    byTimeframe: {},
  };
}

test("alert eligibility fails closed for an unknown primary volatility regime", () => {
  assert.deepEqual(alertEligibility(conviction("unknown")), {
    eligible: false,
    reason: "volatility_regime_unknown",
  });
});

test("alert eligibility keeps the existing quiet rejection and permits normal or wild", () => {
  assert.equal(alertEligibility(conviction("quiet")).eligible, false);
  assert.equal(alertEligibility(conviction("normal")).eligible, true);
  assert.equal(alertEligibility(conviction("wild")).eligible, true);
});

test("alert eligibility suppresses an otherwise eligible active same-side thesis", () => {
  assert.deepEqual(alertEligibility(conviction("normal"), { activeThesis: true }), {
    eligible: false,
    reason: "active_thesis",
  });
});

test("dispatch records a strategy-versioned candidate decision even without Telegram configuration", async () => {
  const evaluatedAt = Date.now() + 99_000_000;
  const symbol = "CANDIDATEALERT";
  const signals: Signal[] = [
    { symbol, type: "rsi_oversold", family: "momentum", direction: "bullish", value: 20, strength: 100, label: "rsi", firedAt: evaluatedAt, timeframe: "4h" },
    { symbol, type: "ema_bullish", family: "trend", direction: "bullish", value: 1, strength: 100, label: "ema", firedAt: evaluatedAt, timeframe: "4h" },
    { symbol, type: "breakout_up", family: "structure", direction: "bullish", value: 1, strength: 100, label: "breakout", firedAt: evaluatedAt, timeframe: "4h" },
  ];
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  try {
    await maybeDispatchAlerts(
      signals,
      new Map([[symbol, 100]]),
      new Map([[symbol, { atrPct: 2 }]]),
      new Map([[symbol, "normal"]]),
      new Map([[symbol, evaluatedAt - 1]]),
      evaluatedAt,
    );
  } finally {
    if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat) process.env.TELEGRAM_CHAT_ID = savedChat;
  }
  const candidates = listAlertCandidates({ symbol, limit: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].strategy_version, "stage1-closed-bars-v2");
  assert.equal(candidates[0].decision_reason, "telegram_not_configured");
  assert.equal(candidates[0].decision_candle_at, evaluatedAt - 1);
  assert.equal(candidates[0].telegram_attempted, 0);
  const features = JSON.parse(candidates[0].feature_json) as {
    primaryVolRegime: string;
    market: { price: number; atrPct: number; fundingHourly: number | null };
    signals: Array<{ type: string; value: number; strength: number; timeframe: string }>;
  };
  assert.equal(features.primaryVolRegime, "normal");
  assert.deepEqual(features.market, { price: 100, atrPct: 2, fundingHourly: null });
  assert.deepEqual(features.signals[0], {
    type: "rsi_oversold",
    value: 20,
    strength: 100,
    timeframe: "4h",
  });
  const shadow = JSON.parse(
    (candidates[0] as typeof candidates[number] & { shadow_policy_json: string }).shadow_policy_json,
  ) as {
    policyVersion: string;
    combinedConservativePass: boolean;
    gates: {
      minimumIndependentFamilies: { pass: boolean };
      fundingHeadwind: { pass: boolean };
    };
  };
  assert.equal(shadow.policyVersion, "stage2-shadow-v1");
  assert.equal(shadow.gates.minimumIndependentFamilies.pass, true);
  assert.equal(shadow.gates.fundingHeadwind.pass, false);
  assert.equal(shadow.combinedConservativePass, false);
});

test("dispatch rejects an untrackable candidate before any Telegram attempt", async () => {
  const evaluatedAt = Date.now() + 100_000_000;
  const symbol = "NOTRADECARD";
  const signals: Signal[] = [
    { symbol, type: "rsi_oversold", family: "momentum", direction: "bullish", value: 20, strength: 100, label: "rsi", firedAt: evaluatedAt, timeframe: "4h" },
    { symbol, type: "ema_bullish", family: "trend", direction: "bullish", value: 1, strength: 100, label: "ema", firedAt: evaluatedAt, timeframe: "4h" },
    { symbol, type: "breakout_up", family: "structure", direction: "bullish", value: 1, strength: 100, label: "breakout", firedAt: evaluatedAt, timeframe: "4h" },
  ];
  await maybeDispatchAlerts(
    signals,
    undefined,
    undefined,
    new Map([[symbol, "normal"]]),
    new Map([[symbol, evaluatedAt - 1]]),
    evaluatedAt,
  );
  const candidate = listAlertCandidates({ symbol, limit: 1 })[0];
  assert.equal(candidate.decision, "rejected");
  assert.equal(candidate.decision_reason, "trade_card_unavailable");
  assert.equal(candidate.telegram_attempted, 0);
});

test("computeTradeCard: long setup sizes risk to 2% of $2k = $40", () => {
  // Entry $100, ATR 2% → ATR = $2 → stop_distance = 1.5 × $2 = $3.
  // Long stop = $100 - $3 = $97. Target = $100 + 3 × $3 = $109.
  // Size = $40 / $3 = 13.333...
  const card = computeTradeCard(100, 2, "bullish");
  assert.ok(card);
  assert.equal(card.stop, 97);
  assert.equal(card.target, 109);
  assert.ok(Math.abs(card.size - 13.333) < 0.01);
  assert.equal(card.riskUsd, 40);
});

test("computeTradeCard: short setup mirrors stop/target above entry", () => {
  // Same numbers, short direction. Stop above, target below.
  const card = computeTradeCard(100, 2, "bearish");
  assert.ok(card);
  assert.equal(card.stop, 103);
  assert.equal(card.target, 91);
});

test("computeTradeCard: respects 3:1 R/R ratio", () => {
  const card = computeTradeCard(50000, 1.5, "bullish");
  assert.ok(card);
  const stopDist = 50000 - card.stop;
  const targetDist = card.target - 50000;
  assert.ok(Math.abs(targetDist / stopDist - 3) < 1e-9, `R/R should be 3:1, got ${targetDist / stopDist}`);
});

test("computeTradeCard: returns null when ATR is missing or zero", () => {
  assert.equal(computeTradeCard(100, 0, "bullish"), null);
  assert.equal(computeTradeCard(100, NaN, "bullish"), null);
  assert.equal(computeTradeCard(100, -1, "bullish"), null);
});

test("computeTradeCard: returns null when entry is invalid", () => {
  assert.equal(computeTradeCard(0, 2, "bullish"), null);
  assert.equal(computeTradeCard(-50, 2, "bullish"), null);
  assert.equal(computeTradeCard(NaN, 2, "bullish"), null);
});

test("computeTradeCard: position size scales linearly with stop distance", () => {
  // Tighter stop → larger position; wider stop → smaller. Risk is held
  // constant by construction.
  const tight = computeTradeCard(100, 1, "bullish");   // 1% ATR → stop_dist = 1.5
  const wide = computeTradeCard(100, 4, "bullish");    // 4% ATR → stop_dist = 6
  assert.ok(tight && wide);
  // Tight stop carries 4× the size of the wide stop (because stop_dist is 4× smaller).
  assert.ok(Math.abs(tight.size / wide.size - 4) < 1e-6);
  // Risk stays $40 in both cases.
  assert.equal(tight.riskUsd, 40);
  assert.equal(wide.riskUsd, 40);
});

const pendingAlert: NewTelegramAlert = {
  created_at: 1_000,
  delivery_status: "pending",
  delivery_error: null,
  telegram_message_id: null,
  symbol: "BTC",
  sector: "crypto majors",
  direction: "long",
  entry_price: 100,
  stop_price: 95,
  target_price: 115,
  size: 8,
  risk_usd: 40,
  conviction_score: 4,
  conviction_json: "{}",
  signal_json: "[]",
  family_json: "[]",
  expires_at: 1_000 + 48 * 60 * 60 * 1000,
  outcome_status: "open",
  outcome_at: null,
  outcome_price: null,
  pnl_r: null,
  evaluated_through: null,
  outcome_note: null,
  outcome_provenance: null,
};

test("tracked Telegram delivery writes pending before send and persists acknowledgement", async () => {
  const events: string[] = [];
  const result = await deliverTrackedTelegramAlert(pendingAlert, "body", {
    insert: () => { events.push("insert"); return 7; },
    onAttempt: (id) => { events.push(`attempt:${id}`); },
    send: async () => { events.push("send"); return { ok: true, messageId: 123 }; },
    markDelivered: (id, messageId, at) => { events.push(`delivered:${id}:${messageId}:${at}`); return true; },
    markFailed: () => { throw new Error("unexpected failure transition"); },
    markUnknown: () => { throw new Error("unexpected unknown transition"); },
    now: () => 2_000,
  });

  assert.equal(result, "fired");
  assert.deepEqual(events, ["insert", "attempt:7", "send", "delivered:7:123:2000"]);
});

test("tracked Telegram delivery does not send when the atomic thesis reservation is blocked", async () => {
  let sent = false;
  let blocked = false;
  const result = await deliverTrackedTelegramAlert(pendingAlert, "body", {
    reserve: () => ({ kind: "blocked", reason: "active_thesis" }),
    onBlocked: () => { blocked = true; },
    send: async () => { sent = true; return { ok: true, messageId: 123 }; },
    markDelivered: () => false,
    markFailed: () => false,
    markUnknown: () => false,
    now: () => 2_000,
  });

  assert.equal(result, "active_thesis");
  assert.equal(blocked, true);
  assert.equal(sent, false);
});

test("tracked Telegram delivery persists a sanitized failure", async () => {
  let persisted = "";
  const result = await deliverTrackedTelegramAlert(pendingAlert, "body", {
    insert: () => 8,
    send: async () => ({ ok: false, failureKind: "rejected", error: "POST https://api.telegram.org/bot123456:SECRET/sendMessage failed" }),
    markDelivered: () => false,
    markFailed: (_id, error) => { persisted = error; return true; },
    markUnknown: () => false,
    now: () => 3_000,
  });

  assert.equal(result, "failed");
  assert.doesNotMatch(persisted, /SECRET|123456/);
  assert.match(persisted, /bot\[REDACTED\]/);
});

test("Telegram success without a message id is recorded as acknowledgement-unknown", async () => {
  let unknown = "";
  const result = await deliverTrackedTelegramAlert(pendingAlert, "body", {
    insert: () => 9,
    send: async () => ({ ok: true }),
    markDelivered: () => false,
    markFailed: () => false,
    markUnknown: (_id, error) => { unknown = error; return true; },
    now: () => 4_000,
  });
  assert.equal(result, "unknown");
  assert.match(unknown, /message id/i);
});

test("ambiguous Telegram transport failure is recorded as unknown and not safely retryable", async () => {
  let unknown = "";
  const result = await deliverTrackedTelegramAlert(pendingAlert, "body", {
    insert: () => 10,
    send: async () => ({ ok: false, failureKind: "unknown", error: "request timed out" }),
    markDelivered: () => false,
    markFailed: () => false,
    markUnknown: (_id, error) => { unknown = error; return true; },
    now: () => 5_000,
  });
  assert.equal(result, "unknown");
  assert.match(unknown, /timed out/i);
});

test("sanitizeTelegramDeliveryError strips bot credentials and bounds storage", () => {
  const clean = sanitizeTelegramDeliveryError(`https://api.telegram.org/bot99:TOPSECRET/sendMessage ${"x".repeat(2_000)}`);
  assert.doesNotMatch(clean, /TOPSECRET|bot99/);
  assert.ok(clean.length <= 1_000);
});

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

import { computeTradeCard } from "../alerter";

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

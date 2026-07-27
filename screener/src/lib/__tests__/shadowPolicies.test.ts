import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateStage2ShadowPolicy } from "../shadowPolicies";
import type { Signal } from "../signals";

const signal = (
  type: Signal["type"],
  family: Signal["family"],
  direction: Signal["direction"],
  timeframe: Signal["timeframe"],
): Signal => ({
  symbol: "SHADOW",
  type,
  family,
  direction,
  timeframe,
  value: 1,
  strength: 80,
  label: type,
  firedAt: 1_000,
});

test("Stage 2 shadow policy records independent gates without changing the baseline decision", () => {
  const result = evaluateStage2ShadowPolicy({
    direction: "long",
    convictionScore: 4.2,
    primaryVolRegime: "normal",
    byTimeframe: { "4h": { score: 2.4, count: 2 } },
    fundingHourly: 0.00002,
    signals: [
      signal("rsi_oversold", "momentum", "bullish", "4h"),
      signal("ema_bullish", "trend", "bullish", "4h"),
    ],
  });

  assert.equal(result.policyVersion, "stage2-shadow-v1");
  assert.equal(result.gates.opposingSignalVeto.pass, true);
  assert.equal(result.gates.minimumIndependentFamilies.pass, true);
  assert.equal(result.gates.fourHourDirectionalConfirmation.pass, true);
  assert.equal(result.gates.fundingHeadwind.pass, true);
  assert.equal(result.gates.scoreAtLeast4.pass, true);
  assert.equal(result.gates.scoreAtLeast4_5.pass, false);
  assert.equal(result.combinedConservativePass, true);
});

test("Stage 2 shadow policy exposes opposing evidence instead of silently netting it away", () => {
  const result = evaluateStage2ShadowPolicy({
    direction: "long",
    convictionScore: 5,
    primaryVolRegime: "normal",
    byTimeframe: { "4h": { score: 2, count: 2 } },
    fundingHourly: 0,
    signals: [
      signal("rsi_oversold", "momentum", "bullish", "4h"),
      signal("ema_bullish", "trend", "bullish", "4h"),
      signal("breakout_down", "structure", "bearish", "1h"),
    ],
  });

  assert.equal(result.gates.opposingSignalVeto.pass, false);
  assert.equal(result.gates.opposingSignalVeto.observed.opposingSignalCount, 1);
  assert.equal(result.combinedConservativePass, false);
});

test("Stage 2 funding headwind uses only the existing extreme-funding bounds", () => {
  const common = {
    convictionScore: 5,
    primaryVolRegime: "normal" as const,
    byTimeframe: { "4h": { score: 2, count: 2 } },
    signals: [
      signal("rsi_oversold", "momentum", "bullish", "4h"),
      signal("ema_bullish", "trend", "bullish", "4h"),
    ],
  };

  assert.equal(evaluateStage2ShadowPolicy({ ...common, direction: "long", fundingHourly: 0.0001 }).gates.fundingHeadwind.pass, true);
  assert.equal(evaluateStage2ShadowPolicy({ ...common, direction: "long", fundingHourly: 0.00010001 }).gates.fundingHeadwind.pass, false);
});

test("Stage 2 funding gate fails closed when the evaluated funding rate is unavailable", () => {
  const result = evaluateStage2ShadowPolicy({
    direction: "long",
    convictionScore: 5,
    primaryVolRegime: "normal",
    byTimeframe: { "4h": { score: 2, count: 2 } },
    fundingHourly: null,
    signals: [
      signal("rsi_oversold", "momentum", "bullish", "4h"),
      signal("ema_bullish", "trend", "bullish", "4h"),
    ],
  });

  assert.equal(result.gates.fundingHeadwind.pass, false);
  assert.equal(result.gates.fundingHeadwind.observed.fundingHourly, null);
  assert.equal(result.combinedConservativePass, false);
});

test("combined Stage 2 policy cannot re-include a candidate rejected by the Stage 1 regime gate", () => {
  const result = evaluateStage2ShadowPolicy({
    direction: "long",
    convictionScore: 5,
    primaryVolRegime: "quiet",
    byTimeframe: { "4h": { score: 2, count: 2 } },
    fundingHourly: 0,
    signals: [
      signal("rsi_oversold", "momentum", "bullish", "4h"),
      signal("ema_bullish", "trend", "bullish", "4h"),
    ],
  });

  assert.equal(result.baselineContext.regimePass, false);
  assert.equal(result.gates.minimumIndependentFamilies.pass, true);
  assert.equal(result.combinedConservativePass, false);
});

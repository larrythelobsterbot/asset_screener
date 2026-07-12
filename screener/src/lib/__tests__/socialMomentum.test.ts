// Unit tests for the attention radar (mention acceleration + price
// divergence classification). Pure-logic coverage: series gating,
// baseline/accel math, the four classification buckets, ranking, and
// the persistence bridge's de-bounce.

// MUST be first: redirects the DAL singleton to a tmpfile so
// buildSocialSignals' event_history writes don't touch data/screener.db.
import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSocialMomentum,
  buildSocialSignals,
  _resetSocialEventHistoryForTests,
  type MomentumInput,
  type SocialSeriesPoint,
} from "../socialMomentum";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

// Hourly series ending at NOW: values[0] is the oldest point.
function series(values: number[]): SocialSeriesPoint[] {
  return values.map((mentions, i) => ({
    ts: NOW - (values.length - 1 - i) * HOUR,
    mentions,
  }));
}

function input(partial: Partial<MomentumInput> & { series: SocialSeriesPoint[] }): MomentumInput {
  return { symbol: "TEST", price24hPct: null, isHL: false, ...partial };
}

test("series too short or too narrow a span is skipped", () => {
  // 4 points = MIN_POINTS but we need MIN_POINTS baseline points PLUS
  // the latest, so 4 total is insufficient.
  assert.equal(computeSocialMomentum([input({ series: series([10, 10, 10, 40]) })]).length, 0);
  // Enough points but compressed into a 5h span (< 12h minimum).
  const compressed = series([10, 10, 10, 10, 10, 40]).map((p, i, arr) => ({
    ...p,
    ts: NOW - (arr.length - 1 - i) * HOUR * 0.5,
  }));
  assert.equal(computeSocialMomentum([input({ series: compressed })]).length, 0);
});

test("accel is latest vs trailing mean, latest point excluded from baseline", () => {
  // Baseline = mean(50×12) = 50; latest 150 → accel 3.
  const rows = computeSocialMomentum([
    input({ series: series([...Array(12).fill(50), 150]) }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].baseline, 50);
  assert.equal(rows[0].accel, 3);
  assert.equal(rows[0].mentions, 150);
});

test("quiet_accumulation: accelerating + flat price", () => {
  const rows = computeSocialMomentum([
    input({
      series: series([...Array(12).fill(40), 120]),
      price24hPct: 0.8,
      isHL: true,
    }),
  ]);
  assert.equal(rows[0].klass, "quiet_accumulation");
});

test("confirmed_move: accelerating + pumping price", () => {
  const rows = computeSocialMomentum([
    input({ series: series([...Array(12).fill(40), 120]), price24hPct: 8 }),
  ]);
  assert.equal(rows[0].klass, "confirmed_move");
});

test("accelerating: no price context, or price between flat and pump", () => {
  const noPrice = computeSocialMomentum([
    input({ series: series([...Array(12).fill(40), 120]) }),
  ]);
  assert.equal(noPrice[0].klass, "accelerating");
  const midPrice = computeSocialMomentum([
    input({ series: series([...Array(12).fill(40), 120]), price24hPct: 3.5 }),
  ]);
  assert.equal(midPrice[0].klass, "accelerating");
});

test("hollow_pump: price up hard while attention fades from a real baseline", () => {
  const rows = computeSocialMomentum([
    input({ series: series([...Array(12).fill(100), 50]), price24hPct: 9 }),
  ]);
  assert.equal(rows[0].klass, "hollow_pump");
  // Same fade but the baseline never mattered (8 mentions) → no class.
  const offRadar = computeSocialMomentum([
    input({ series: series([...Array(12).fill(8), 4]), price24hPct: 9 }),
  ]);
  assert.equal(offRadar[0].klass, null);
});

test("low-mention accelerations are noise, not signal", () => {
  // 8 → 24 mentions is a 3× accel but under MIN_MENTIONS.
  const rows = computeSocialMomentum([
    input({ series: series([...Array(12).fill(8), 24]), price24hPct: 0 }),
  ]);
  assert.equal(rows[0].klass, null);
});

test("classified rows rank above unclassified regardless of accel ratio", () => {
  const rows = computeSocialMomentum([
    input({ symbol: "HOLLOW", series: series([...Array(12).fill(100), 50]), price24hPct: 9 }),
    input({ symbol: "MEH", series: series([...Array(12).fill(50), 70]) }), // 1.4× — nothing
  ]);
  assert.equal(rows[0].symbol, "HOLLOW");
  assert.equal(rows[1].symbol, "MEH");
});

test("buildSocialSignals: HL-only, typed by class, de-bounced on refire", () => {
  _resetSocialEventHistoryForTests();
  const rows = computeSocialMomentum([
    input({
      symbol: "ALPHA",
      series: series([...Array(12).fill(40), 120]),
      price24hPct: 0.5,
      isHL: true,
    }),
    input({
      symbol: "BETA",
      series: series([...Array(12).fill(100), 50]),
      price24hPct: 9,
      isHL: true,
    }),
    input({
      symbol: "OFFHL",
      series: series([...Array(12).fill(40), 120]),
      price24hPct: 0.5,
      isHL: false,
    }),
  ]);
  const signals = buildSocialSignals(rows);
  assert.equal(signals.length, 2);
  const bySym = new Map(signals.map((s) => [s.symbol, s]));
  assert.equal(bySym.get("ALPHA")?.type, "social_accel");
  assert.equal(bySym.get("ALPHA")?.direction, "bullish");
  assert.equal(bySym.get("BETA")?.type, "social_divergence");
  assert.equal(bySym.get("BETA")?.direction, "bearish");
  assert.equal(bySym.has("OFFHL"), false);

  // Immediate refire is swallowed by the 12h de-bounce.
  assert.equal(buildSocialSignals(rows).length, 0);
});

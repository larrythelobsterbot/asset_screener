// Unit tests for the signal engine.
//
// Runs on Node's built-in test runner via `npm test` (no extra deps).
// Focuses on the bits most likely to break silently under refactors:
// funding percentile gating, sector-RS z-scoring, conviction composition,
// and pivot-based divergence detection.
//
// We don't test the per-indicator math itself — that's covered by
// indicators.test.ts sister file — just the SIGNAL-LEVEL behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectSignals,
  detectSectorRelativeStrength,
  scoreConviction,
  type Signal,
  type SectorSnapshot,
} from "../signals";
import { detectDivergences, atrPercent, classifyVolRegime } from "../indicators";

// ── helpers ────────────────────────────────────────────────────────────
// Deterministic test series: a steady uptrend with a single pullback so
// we can assert specific signal families fire/don't fire.
function uptrendSeries(n = 200): {
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
} {
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.5 + Math.sin(i / 6) * 1.5;
    closes.push(base);
    highs.push(base + 0.4);
    lows.push(base - 0.4);
    volumes.push(1000 + Math.sin(i / 10) * 100);
  }
  return { closes, highs, lows, volumes };
}

// ── detectSignals / volume spike ───────────────────────────────────────
test("detectSignals fires volume_spike when last bar >2× avg", () => {
  const { closes, highs, lows, volumes } = uptrendSeries(100);
  volumes[volumes.length - 1] = 5000; // >>2× the ~1000 baseline
  const signals = detectSignals("TEST", closes, volumes, highs, lows);
  const vs = signals.find((s) => s.type === "volume_spike");
  assert.ok(vs, "expected a volume_spike signal");
  assert.equal(vs?.family, "volume");
  assert.ok((vs?.strength ?? 0) >= 40, "strength should be scaled");
});

// ── detectSignals / breakout ────────────────────────────────────────────
test("detectSignals fires breakout_up when close breaks 20-bar high", () => {
  const { closes, highs, lows, volumes } = uptrendSeries(100);
  closes[closes.length - 1] = Math.max(...highs.slice(-21, -1)) + 10;
  const signals = detectSignals("TEST", closes, volumes, highs, lows);
  const br = signals.find((s) => s.type === "breakout_up");
  assert.ok(br, "expected breakout_up");
});

// ── Funding percentile gating ──────────────────────────────────────────
test("funding_anomaly requires current rate in top/bottom decile when history is long enough", () => {
  const { closes, highs, lows, volumes } = uptrendSeries(60);
  // 48 samples at ~0.00005 (0.005%/hr) — a "normal" regime. A current
  // reading just above the mean should NOT fire.
  const hist = Array.from({ length: 48 }, () => 0.00005);
  const noFire = detectSignals("TEST", closes, volumes, highs, lows, 0.00006, hist);
  assert.equal(noFire.filter((s) => s.type === "funding_anomaly").length, 0);

  // A clear top-decile outlier should fire bearish.
  const fire = detectSignals("TEST", closes, volumes, highs, lows, 0.002, hist);
  const fa = fire.find((s) => s.type === "funding_anomaly");
  assert.ok(fa, "expected funding_anomaly on top-decile funding");
  assert.equal(fa?.direction, "bearish");
});

test("funding_anomaly cold-start uses conservative absolute threshold", () => {
  const { closes, highs, lows, volumes } = uptrendSeries(60);
  // No history provided — only very extreme funding should fire.
  const mild = detectSignals("TEST", closes, volumes, highs, lows, 0.0002, []);
  assert.equal(mild.filter((s) => s.type === "funding_anomaly").length, 0);
  const extreme = detectSignals("TEST", closes, volumes, highs, lows, 0.001, []);
  assert.ok(extreme.find((s) => s.type === "funding_anomaly"));
});

// ── Sector-relative strength ───────────────────────────────────────────
test("detectSectorRelativeStrength flags outlier in a well-populated sector", () => {
  // 8 members, one clear leader, one clear laggard, rest flat around 1%.
  const snapshot: SectorSnapshot[] = [
    { symbol: "A", sector: "l1", change24h: 0.9 },
    { symbol: "B", sector: "l1", change24h: 1.1 },
    { symbol: "C", sector: "l1", change24h: 0.8 },
    { symbol: "D", sector: "l1", change24h: 1.0 },
    { symbol: "E", sector: "l1", change24h: 1.2 },
    { symbol: "F", sector: "l1", change24h: 0.7 },
    { symbol: "LEADER", sector: "l1", change24h: 8.0 },
    { symbol: "LAGGARD", sector: "l1", change24h: -5.0 },
  ];
  const signals = detectSectorRelativeStrength(snapshot);
  const leader = signals.find((s) => s.symbol === "LEADER");
  const laggard = signals.find((s) => s.symbol === "LAGGARD");
  assert.ok(leader && leader.type === "sector_leader");
  assert.ok(laggard && laggard.type === "sector_laggard");
});

test("detectSectorRelativeStrength skips sectors below the minimum member count", () => {
  const snapshot: SectorSnapshot[] = [
    { symbol: "A", sector: "meme", change24h: 1 },
    { symbol: "B", sector: "meme", change24h: 2 },
    { symbol: "EXTREME", sector: "meme", change24h: 50 },
  ];
  const signals = detectSectorRelativeStrength(snapshot);
  assert.equal(signals.length, 0, "3 members is below threshold — should not fire");
});

// ── Conviction composition ─────────────────────────────────────────────
test("scoreConviction labels Strong Buy when multiple aligned bullish families fire", () => {
  const now = Date.now();
  const signals: Signal[] = [
    { symbol: "X", type: "rsi_oversold", family: "momentum", direction: "bullish", value: 25, strength: 70, label: "", firedAt: now, timeframe: "4h" },
    { symbol: "X", type: "ema_bullish", family: "trend", direction: "bullish", value: 0.5, label: "", firedAt: now, timeframe: "4h" },
    { symbol: "X", type: "breakout_up", family: "structure", direction: "bullish", value: 100, label: "", firedAt: now, timeframe: "1d" },
    { symbol: "X", type: "volume_spike", family: "volume", direction: "bullish", value: 3, strength: 60, label: "", firedAt: now, timeframe: "4h" },
  ];
  const r = scoreConviction(signals);
  assert.equal(r.label, "Strong Buy");
  assert.ok(r.score > 0);
  assert.equal(r.bullishCount, 4);
  assert.equal(r.bearishCount, 0);
  assert.ok(r.contributingFamilies.length >= 3, "diversity bonus depends on this");
});

test("scoreConviction returns Neutral on no signals", () => {
  const r = scoreConviction([]);
  assert.equal(r.label, "Neutral");
  assert.equal(r.score, 0);
});

test("scoreConviction nets out opposing signals", () => {
  const now = Date.now();
  const signals: Signal[] = [
    { symbol: "X", type: "rsi_overbought", family: "momentum", direction: "bearish", value: 75, label: "", firedAt: now, timeframe: "4h" },
    { symbol: "X", type: "rsi_oversold", family: "momentum", direction: "bullish", value: 25, label: "", firedAt: now, timeframe: "4h" },
  ];
  const r = scoreConviction(signals);
  assert.equal(r.label, "Neutral");
});

// ── Divergence detection ───────────────────────────────────────────────
test("detectDivergences catches a bullish price-lower-low / RSI-higher-low", () => {
  // Construct a V→V series where the two most recent local lows are at
  // indices 8 and 20. Flat surrounding values would themselves be pivots
  // (the detector uses `<=`), so we vary the non-pivot bars to ensure
  // only indices 8 and 20 qualify as the last two pivots.
  const closes: number[] = [];
  const rsi: (number | null)[] = [];
  for (let i = 0; i < 25; i++) {
    // Base uptrend with two dips
    let c = 100 + i * 0.5;
    let r = 45 + Math.sin(i / 4) * 2; // wobbles around 45
    if (i === 8) {
      c = 70; // first low
      r = 28; // RSI at first low
    }
    if (i === 20) {
      c = 65; // lower low in price
      r = 35; // but RSI higher than the previous low — divergence
    }
    closes.push(c);
    rsi.push(r);
  }
  const r = detectDivergences(closes, rsi, 25);
  // Note: the non-dip bars form pivot highs at indices 7 and 19 as well
  // (the neighbours either side of each dip), so a bearish divergence can
  // legitimately co-exist in this fixture. We only assert the bullish
  // case we're testing is detected — the detector is allowed to flag both
  // when the RSI at those high pivots happens to diverge too.
  assert.equal(r.bullish, true, `expected bullish, got ${JSON.stringify(r)}`);
});

test("detectDivergences returns false when no pivots found", () => {
  const closes = new Array(10).fill(100);
  const rsi = new Array(10).fill(50);
  const r = detectDivergences(closes, rsi, 30);
  assert.equal(r.bullish, false);
  assert.equal(r.bearish, false);
});

// ── Volatility regime classification ───────────────────────────────────
test("classifyVolRegime buckets against percentile bounds", () => {
  const hist = Array.from({ length: 50 }, (_, i) => i + 1); // 1..50 ATR%
  assert.equal(classifyVolRegime(5, hist), "quiet", "5 < p25 (≈13)");
  assert.equal(classifyVolRegime(25, hist), "normal", "25 within p25..p75");
  assert.equal(classifyVolRegime(45, hist), "wild", "45 > p75 (≈38)");
  assert.equal(classifyVolRegime(null, hist), "unknown");
  assert.equal(classifyVolRegime(10, hist.slice(0, 5)), "unknown", "too few samples");
});

// ── ATR sanity ─────────────────────────────────────────────────────────
test("atrPercent returns null below the warm-up window and a positive number after", () => {
  const { closes, highs, lows } = uptrendSeries(50);
  const series = atrPercent(highs, lows, closes, 14);
  assert.equal(series[0], null);
  assert.equal(series[12], null);
  assert.ok(series[20] != null && series[20]! > 0);
});

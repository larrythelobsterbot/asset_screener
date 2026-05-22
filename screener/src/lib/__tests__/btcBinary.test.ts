// Tests for the HIP-4 binary parser + probability model.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBinaryDescription,
  findActiveBtcBinary,
  modelYesProbability,
  annualizedRealizedVol,
} from "../btcBinary";

// ── parseBinaryDescription ─────────────────────────────────────────────

test("parseBinaryDescription decodes a well-formed BTC binary", () => {
  const desc = "class:priceBinary|underlying:BTC|expiry:20260523-0600|targetPrice:77451|period:1d";
  const p = parseBinaryDescription(desc);
  assert.ok(p);
  assert.equal(p?.class, "priceBinary");
  assert.equal(p?.underlying, "BTC");
  assert.equal(p?.targetPrice, 77451);
  assert.equal(p?.period, "1d");
  // 2026-05-23 06:00 UTC = (per Date.UTC)
  assert.equal(p?.expiryMs, Date.UTC(2026, 4, 23, 6, 0, 0));
});

test("parseBinaryDescription rejects malformed/unknown descriptions", () => {
  assert.equal(parseBinaryDescription("class:priceBucket|underlying:BTC"), null);
  assert.equal(parseBinaryDescription("other"), null);
  assert.equal(parseBinaryDescription("class:priceBinary|underlying:BTC|expiry:bad"), null);
});

// ── findActiveBtcBinary ────────────────────────────────────────────────

test("findActiveBtcBinary picks the soonest-future BTC binary", () => {
  const now = Date.now();
  const dayMs = 86_400_000;
  const fmt = (msFromNow: number): string => {
    const d = new Date(now + msFromNow);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  };
  const result = findActiveBtcBinary([
    // already settled
    { outcome: 79, name: "x", description: `class:priceBinary|underlying:BTC|expiry:${fmt(-dayMs)}|targetPrice:60000|period:1d`, sideSpecs: [{ name: "Yes" }, { name: "No" }] },
    // tomorrow
    { outcome: 80, name: "x", description: `class:priceBinary|underlying:BTC|expiry:${fmt(dayMs)}|targetPrice:70000|period:1d`, sideSpecs: [{ name: "Yes" }, { name: "No" }] },
    // 2 days out
    { outcome: 81, name: "x", description: `class:priceBinary|underlying:BTC|expiry:${fmt(2 * dayMs)}|targetPrice:71000|period:1d`, sideSpecs: [{ name: "Yes" }, { name: "No" }] },
    // ETH binary — ignore
    { outcome: 82, name: "x", description: `class:priceBinary|underlying:ETH|expiry:${fmt(dayMs)}|targetPrice:3000|period:1d`, sideSpecs: [{ name: "Yes" }, { name: "No" }] },
    // Multi-price bucket — ignore (different class)
    { outcome: 83, name: "x", description: `class:priceBucket|underlying:BTC|expiry:${fmt(dayMs)}|priceThresholds:65000,75000|period:1d`, sideSpecs: [{ name: "Yes" }, { name: "No" }] },
  ]);
  assert.ok(result);
  assert.equal(result?.outcomeId, 80, "should pick the next-expiring BTC binary");
  assert.equal(result?.targetPrice, 70000);
  // Encoding: yes = 10*80 + 0 = 800, no = 801
  assert.equal(result?.yesCoin, "#800");
  assert.equal(result?.noCoin, "#801");
  assert.equal(result?.yesAssetId, 100_000_800);
  assert.equal(result?.noAssetId,  100_000_801);
});

test("findActiveBtcBinary returns null when no BTC binary is active", () => {
  assert.equal(findActiveBtcBinary([]), null);
});

// ── Probability model ──────────────────────────────────────────────────

test("modelYesProbability: at-the-money returns ~0.5", () => {
  const p = modelYesProbability({
    spot: 70000,
    strike: 70000,
    ttlMs: 86_400_000,
    sigmaAnnualized: 0.5,
  });
  // ATM with positive vol → very close to 0.5 (slightly below due to
  // the −σ²/2 drift term).
  assert.ok(p > 0.45 && p < 0.5, `expected ~0.49, got ${p}`);
});

test("modelYesProbability: deep-OTM call → small probability", () => {
  const p = modelYesProbability({
    spot: 70000,
    strike: 100000,
    ttlMs: 86_400_000,        // 1 day
    sigmaAnnualized: 0.6,
  });
  assert.ok(p < 0.05, `deep OTM should be < 5%, got ${p}`);
});

test("modelYesProbability: deep-ITM call → near-certain probability", () => {
  const p = modelYesProbability({
    spot: 70000,
    strike: 40000,
    ttlMs: 86_400_000,
    sigmaAnnualized: 0.6,
  });
  assert.ok(p > 0.95, `deep ITM should be > 95%, got ${p}`);
});

test("modelYesProbability: zero TTL returns deterministic outcome", () => {
  assert.equal(modelYesProbability({ spot: 100, strike: 50, ttlMs: 0, sigmaAnnualized: 0.5 }), 1);
  assert.equal(modelYesProbability({ spot: 50, strike: 100, ttlMs: 0, sigmaAnnualized: 0.5 }), 0);
});

test("modelYesProbability: invalid inputs return ignorant prior (0.5)", () => {
  assert.equal(modelYesProbability({ spot: 0, strike: 100, ttlMs: 1000, sigmaAnnualized: 0.5 }), 0.5);
  assert.equal(modelYesProbability({ spot: 100, strike: 100, ttlMs: 1000, sigmaAnnualized: 0 }), 0.5);
});

// ── annualizedRealizedVol ──────────────────────────────────────────────

test("annualizedRealizedVol: constant series returns ~0", () => {
  const v = annualizedRealizedVol([100, 100, 100, 100, 100]);
  assert.ok(v != null && v < 1e-9, `flat series should have ~0 vol, got ${v}`);
});

test("annualizedRealizedVol: returns null on insufficient data", () => {
  assert.equal(annualizedRealizedVol([]), null);
  assert.equal(annualizedRealizedVol([100]), null);
});

test("annualizedRealizedVol: produces a plausible BTC-like value", () => {
  // Synthetic series with ~3% daily moves alternating direction —
  // roughly mimics BTC. Annualized should land in a sensible range.
  const closes: number[] = [];
  let p = 70_000;
  for (let i = 0; i < 30; i++) {
    p *= 1 + (i % 2 === 0 ? 0.03 : -0.029);
    closes.push(p);
  }
  const v = annualizedRealizedVol(closes);
  assert.ok(v != null);
  assert.ok(v! > 0.3 && v! < 1.5, `expected 0.3–1.5 (annual), got ${v}`);
});

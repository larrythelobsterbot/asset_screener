// Tests for the TWAP buy-pressure formula. We don't hit the live API
// here — the math is what we care about. Builds tiny fake TWAP arrays
// that exercise each branch of computePressureFromTwaps().

import { test } from "node:test";
import assert from "node:assert/strict";
import { computePressureFromTwaps } from "../hypurrscan";

// Helper: build a synthetic TWAP with sane defaults. assetId defaults to
// 10107 (HYPE spot) — pass `assetId: 159` for perp HYPE or any other id
// to test the market-filter behaviour.
function twap(opts: {
  startMs: number;
  durationMin: number;
  sizeHype: number;
  buy: boolean;
  ended?: string;
  assetId?: number;
}): Parameters<typeof computePressureFromTwaps>[0][number] {
  return {
    time: opts.startMs,
    user: "0xdeadbeef",
    action: {
      type: "twapOrder",
      twap: {
        a: opts.assetId ?? 10107,           // default HYPE spot; tests can override
        b: opts.buy,
        s: opts.sizeHype.toString(),
        r: false,
        m: opts.durationMin,
        t: false,
      },
    },
    hash: "0xtest",
    error: null,
    ...(opts.ended ? { ended: opts.ended } : {}),
  };
}

const NOW = 1_700_000_000_000;
const HYPE_PRICE = 50;

test("computePressureFromTwaps: single 60-min buy TWAP that's just started", () => {
  // 1000 HYPE × $50 = $50,000 value, executed evenly over 60 min.
  // For the next 1h window, the full TWAP completes within window →
  // full $50,000 should be the 1h pressure.
  const r = computePressureFromTwaps(
    [twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true })],
    HYPE_PRICE,
    NOW,
  );
  assert.equal(r.active_twap_count, 1);
  // Allow small float error.
  assert.ok(Math.abs(r.pressure_1h_usd - 50_000) < 1, `got ${r.pressure_1h_usd}`);
  // 24h pressure is also $50,000 because the TWAP completes well within 24h.
  assert.ok(Math.abs(r.pressure_24h_usd - 50_000) < 1);
});

test("computePressureFromTwaps: 4-hour TWAP — only quarter fits in the 1h window", () => {
  // 2000 HYPE × $50 = $100,000 value, executed evenly over 240 min.
  // 1h slice of that = 60/240 = 25% = $25,000.
  // 24h slice catches the entire thing = $100,000.
  const r = computePressureFromTwaps(
    [twap({ startMs: NOW, durationMin: 240, sizeHype: 2000, buy: true })],
    HYPE_PRICE,
    NOW,
  );
  assert.ok(Math.abs(r.pressure_1h_usd - 25_000) < 1, `got ${r.pressure_1h_usd}`);
  assert.ok(Math.abs(r.pressure_24h_usd - 100_000) < 1);
});

test("computePressureFromTwaps: sells subtract from buys (net pressure)", () => {
  // 1000 HYPE buy + 1000 HYPE sell, both same start + duration → net zero.
  const r = computePressureFromTwaps(
    [
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true }),
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: false }),
    ],
    HYPE_PRICE,
    NOW,
  );
  assert.ok(Math.abs(r.pressure_1h_usd) < 1, `got ${r.pressure_1h_usd}`);
  assert.equal(r.active_twap_count, 2, "both TWAPs are active even if they net out");
});

test("computePressureFromTwaps: ended TWAPs are skipped", () => {
  const r = computePressureFromTwaps(
    [
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true, ended: "user" }),
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true }),
    ],
    HYPE_PRICE,
    NOW,
  );
  // Only the second one contributes.
  assert.equal(r.active_twap_count, 1);
  assert.ok(Math.abs(r.pressure_1h_usd - 50_000) < 1);
});

test("computePressureFromTwaps: already-finished TWAPs are skipped", () => {
  // Started 2h ago, 30min duration → ended 90min ago → skip.
  const r = computePressureFromTwaps(
    [twap({ startMs: NOW - 2 * 3600 * 1000, durationMin: 30, sizeHype: 1000, buy: true })],
    HYPE_PRICE,
    NOW,
  );
  assert.equal(r.active_twap_count, 0);
  assert.equal(r.pressure_1h_usd, 0);
  assert.equal(r.pressure_24h_usd, 0);
});

test("computePressureFromTwaps: TWAP started 30min ago with 60min duration", () => {
  // 30min already executed; only the next 30min remain → counts toward
  // the next-1h window, but is only HALF the TWAP value.
  const r = computePressureFromTwaps(
    [twap({ startMs: NOW - 30 * 60 * 1000, durationMin: 60, sizeHype: 1000, buy: true })],
    HYPE_PRICE,
    NOW,
  );
  // Half remaining × $50k full value = $25k contribution.
  assert.ok(Math.abs(r.pressure_1h_usd - 25_000) < 1, `got ${r.pressure_1h_usd}`);
});

test("computePressureFromTwaps: includes both HYPE perp (159) and HYPE spot (10107)", () => {
  // Two identical buy TWAPs differing only by asset id. With default
  // hypeMarketIds [159, 10107] both should contribute.
  const r = computePressureFromTwaps(
    [
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true, assetId: 159   }),
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true, assetId: 10107 }),
    ],
    HYPE_PRICE,
    NOW,
  );
  assert.equal(r.active_twap_count, 2);
  // Each contributes $50,000 → total $100,000 over 1h.
  assert.ok(Math.abs(r.pressure_1h_usd - 100_000) < 1);
});

test("computePressureFromTwaps: ignores TWAPs on unrelated markets (e.g. asset 0 = BTC)", () => {
  // BTC perp (a=0) should NOT contribute to HYPE pressure even with
  // huge size, because the market filter excludes it.
  const r = computePressureFromTwaps(
    [
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true, assetId: 159 }),
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1_000_000, buy: true, assetId: 0 }),
    ],
    HYPE_PRICE,
    NOW,
  );
  assert.equal(r.active_twap_count, 1, "only the HYPE-asset-id TWAP contributes");
  assert.ok(Math.abs(r.pressure_1h_usd - 50_000) < 1);
});

test("computePressureFromTwaps: custom marketIds override works", () => {
  // Caller supplies a non-default market id; HYPE asset ids should NOT
  // contribute when not in the list.
  const r = computePressureFromTwaps(
    [
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true, assetId: 159 }),
      twap({ startMs: NOW, durationMin: 60, sizeHype: 1000, buy: true, assetId: 42  }),
    ],
    HYPE_PRICE,
    NOW,
    [42],  // override: only count asset_id 42
  );
  assert.equal(r.active_twap_count, 1);
});

test("computePressureFromTwaps: zero/negative size is filtered", () => {
  const r = computePressureFromTwaps(
    [
      twap({ startMs: NOW, durationMin: 60, sizeHype: 0, buy: true }),
      twap({ startMs: NOW, durationMin: 60, sizeHype: -100, buy: true }),
    ],
    HYPE_PRICE,
    NOW,
  );
  assert.equal(r.active_twap_count, 0);
});

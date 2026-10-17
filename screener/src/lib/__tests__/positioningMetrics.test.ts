import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assessPayloadFreshness,
  derivePositioningObservation,
  type PositioningObservationInput,
} from "../positioningMetrics";

const base: PositioningObservationInput = {
  symbol: "SPX",
  horizonMs: 15 * 60_000,
  toleranceMs: 60_000,
  displayScale: 20_000,
  current: { ts: 1_000_000, mark: 5_000, oiCoins: 12 },
  prior: { ts: 100_000, mark: 4_900, oiCoins: 10 },
  now: 1_000_000,
  currentMaxAgeMs: 2 * 60_000,
};

function observe(overrides: Partial<PositioningObservationInput> = {}) {
  return derivePositioningObservation({ ...base, ...overrides });
}

test("contract OI semantics separate price, contracts, quantity effect, and USD delta", () => {
  const result = observe({
    current: { ts: 1_000_000, mark: 5_100, oiCoins: 10 },
    prior: { ts: 100_000, mark: 5_000, oiCoins: 10 },
  });
  assert.equal(result.status, "observed");
  assert.equal(result.priceChangePct, 2);
  assert.equal(result.oiCoinsChangePct, 0);
  assert.equal(result.oiQuantityDeltaUsd, 0);
  assert.ok(Math.abs((result.oiUsdDelta ?? 0) - 0.05) < 1e-12);
  assert.equal(result.priceDirection, "up");
  assert.equal(result.contractDirection, "flat");
  assert.equal(result.quadrant, "price_up_contracts_flat");
});

test("genuine contract growth is not conflated with price appreciation", () => {
  const result = observe({
    current: { ts: 1_000_000, mark: 5_000, oiCoins: 12 },
    prior: { ts: 100_000, mark: 5_000, oiCoins: 10 },
  });
  assert.equal(result.oiCoinsChangePct, 20);
  assert.equal(result.oiQuantityDeltaUsd, 0.5);
  assert.equal(result.oiUsdDelta, 0.5);
  assert.equal(result.quadrant, "price_flat_contracts_up");
});

test("contract growth can be accompanied by USD OI contraction", () => {
  const result = observe({
    current: { ts: 1_000_000, mark: 90, oiCoins: 110 },
    prior: { ts: 100_000, mark: 100, oiCoins: 100 },
  });
  assert.equal(result.oiCoinsChangePct, 10);
  assert.equal(result.oiQuantityDeltaUsd, 0.05);
  assert.ok(Math.abs((result.oiUsdDelta ?? 0) - (-0.005)) < 1e-12);
  assert.equal(result.quadrant, "price_down_contracts_up");
});

test("zero current contracts is valid and reports full contraction", () => {
  const result = observe({
    current: { ts: 1_000_000, mark: 90, oiCoins: 0 },
    prior: { ts: 100_000, mark: 100, oiCoins: 100 },
  });
  assert.equal(result.status, "observed");
  assert.equal(result.oiCoinsChangePct, -100);
  assert.equal(result.oiQuantityDeltaUsd, -0.5);
  assert.equal(result.oiUsdDelta, -0.5);
  assert.equal(result.contractDirection, "down");
});

test("missing or zero-prior history is unavailable rather than flat", () => {
  assert.equal(observe({ prior: null }).status, "unavailable");
  assert.equal(observe({ prior: { ts: 100_000, mark: 5_000, oiCoins: 0 } }).status, "unavailable");
  assert.equal(observe({ prior: null }).quadrant, "unavailable");
});

test("display scale converts contract quantity effects to raw quote USD", () => {
  const result = observe({
    displayScale: 20_000,
    current: { ts: 1_000_000, mark: 5_200, oiCoins: 3 },
    prior: { ts: 100_000, mark: 5_000, oiCoins: 2 },
  });
  assert.equal(result.oiQuantityDeltaUsd, 0.25);
  assert.equal(result.oiUsdDelta, 0.28);
});

test("bounded history age distinguishes stale observations from unavailable history", () => {
  const stale = observe({
    current: { ts: 1_000_000, mark: 5_000, oiCoins: 10 },
    prior: { ts: 0, mark: 5_000, oiCoins: 9 },
  });
  assert.equal(stale.status, "stale");

  const outsideLookback = observe({
    prior: { ts: 0, mark: 5_000, oiCoins: 9 },
    toleranceMs: 10_000,
  });
  assert.equal(outsideLookback.status, "stale");
});

test("source-aged current observations are stale even when the pair has valid history", () => {
  const stale = observe({
    now: 1_180_001,
    current: { ts: 1_000_000, mark: 5_000, oiCoins: 10 },
    prior: { ts: 100_000, mark: 5_000, oiCoins: 9 },
    currentMaxAgeMs: 2 * 60_000,
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.quadrant, "unavailable");
  assert.match(stale.statusReason ?? "", /current observation is stale/);
});

test("finite inputs that overflow a derived metric are unavailable", () => {
  const overflow = observe({
    current: { ts: 1_000_000, mark: Number.MAX_VALUE, oiCoins: Number.MAX_VALUE },
    prior: { ts: 100_000, mark: Number.MAX_VALUE / 2, oiCoins: Number.MAX_VALUE / 2 },
  });
  assert.equal(overflow.status, "unavailable");
  assert.equal(overflow.quadrant, "unavailable");
  assert.match(overflow.statusReason ?? "", /overflow/);
  for (const value of [overflow.priceChangePct, overflow.oiCoinsChangePct, overflow.oiQuantityDeltaUsd, overflow.oiUsdDelta]) {
    assert.ok(value === null || Number.isFinite(value));
  }
});

test("price and contract dead zones are independently configurable", () => {
  const result = observe({
    priceDeadZonePct: 5,
    contractDeadZonePct: 0.1,
    current: { ts: 1_000_000, mark: 5_010, oiCoins: 11 },
    prior: { ts: 100_000, mark: 5_000, oiCoins: 10 },
  });
  assert.equal(result.priceDirection, "flat");
  assert.equal(result.contractDirection, "up");
});


test("payload freshness fails closed after bounded stale grace", () => {
  assert.deepEqual(assessPayloadFreshness(1_000, 1_000, 5_000, 10_000), { status: "fresh", ageMs: 0 });
  assert.deepEqual(assessPayloadFreshness(1_000, 6_001, 5_000, 10_000), { status: "stale", ageMs: 5_001 });
  assert.deepEqual(assessPayloadFreshness(1_000, 11_001, 5_000, 10_000), { status: "expired", ageMs: 10_001 });
  assert.deepEqual(assessPayloadFreshness(10_000, 9_000, 5_000, 10_000), { status: "invalid", ageMs: null });
});

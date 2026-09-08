import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OI_SURGE_POLICY,
  OI_SURGE_POLICY_VERSION,
  deriveOiSurgeObservation,
  latestOiSurgeEventsBySymbol,
  selectPersistentOiSurgeDetection,
  type OiSurgeHorizon,
  type OiSurgeObservation,
  type OiSurgeSnapshot,
} from "../oiSurge";

function snapshot(overrides: Partial<OiSurgeSnapshot> = {}): OiSurgeSnapshot {
  return {
    ts: 1_800_000_000_000,
    mark: 100,
    oi: 1_000_000,
    funding: 0.0001,
    volume: 20_000_000,
    ...overrides,
  };
}

function derive(
  horizon: OiSurgeHorizon,
  current: OiSurgeSnapshot,
  prior: OiSurgeSnapshot,
  displayScale = 1,
): OiSurgeObservation {
  const observation = deriveOiSurgeObservation({
    symbol: "TEST",
    horizon,
    current,
    prior,
    displayScale,
  });
  assert.ok(observation, "fixture should produce a valid observation");
  return observation;
}

test("OI surge policy is explicitly versioned and shadow-only", () => {
  assert.match(OI_SURGE_POLICY_VERSION, /^oi-surge-shadow-v\d+$/);
  assert.equal(DEFAULT_OI_SURGE_POLICY.mode, "shadow");
  assert.equal(DEFAULT_OI_SURGE_POLICY.minCurrentVolume24hUsd, 5_000_000);
  assert.equal(DEFAULT_OI_SURGE_POLICY.minReferenceOiUsd, 10_000_000);
  assert.equal(DEFAULT_OI_SURGE_POLICY.currentSnapshotMaxAgeMs, 2 * 60_000);
});

test("deriveOiSurgeObservation separates coin-OI expansion from price-driven USD OI", () => {
  const prior = snapshot({ ts: 1_800_000_000_000, mark: 100, oi: 1_000_000 });
  const current = snapshot({ ts: 1_800_000_900_000, mark: 102, oi: 1_080_000 });
  const observation = derive("15m", current, prior);

  assert.equal(observation.oiCoinsChangePct, 8);
  assert.equal(observation.oiQuantityDeltaUsd, 8_000_000);
  assert.equal(observation.priorOiUsd, 100_000_000);
  assert.equal(observation.currentOiUsd, 110_160_000);
  assert.equal(observation.oiUsdDelta, 10_160_000);
  assert.equal(observation.priceChangePct, 2);
  assert.equal(observation.quadrant, "expanding_up");
  assert.equal(observation.severity, "high");
  assert.deepEqual(observation.lanes, ["relative"]);
});

test("deriveOiSurgeObservation uses raw price for display-scaled contracts", () => {
  const prior = snapshot({ mark: 6_000, oi: 50_000_000 });
  const current = snapshot({ ts: 1_800_000_900_000, mark: 6_060, oi: 55_000_000 });
  const observation = derive("15m", current, prior, 20_000);

  assert.equal(observation.priorOiUsd, 15_000_000);
  assert.equal(observation.currentOiUsd, 16_665_000);
  assert.equal(observation.oiQuantityDeltaUsd, 1_500_000);
  assert.equal(observation.oiCoinsChangePct, 10);
  assert.equal(observation.priceChangePct, 1);
  assert.equal(observation.severity, null, "notional gate should reject a display-scale mirage");
});

test("relative and systemic lanes classify high and extreme expansions", () => {
  const relativeHigh = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, oi: 1_080_000 }),
    snapshot({ oi: 1_000_000 }),
  );
  assert.equal(relativeHigh.severity, "high");
  assert.deepEqual(relativeHigh.lanes, ["relative"]);

  const relativeExtreme = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, oi: 1_120_000 }),
    snapshot({ oi: 1_000_000 }),
  );
  assert.equal(relativeExtreme.severity, "extreme");
  assert.deepEqual(relativeExtreme.lanes, ["relative"]);

  const systemicHigh = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, mark: 1_000, oi: 1_025_000, volume: 100_000_000 }),
    snapshot({ mark: 1_000, oi: 1_000_000, volume: 100_000_000 }),
  );
  assert.equal(systemicHigh.oiQuantityDeltaUsd, 25_000_000);
  assert.equal(systemicHigh.severity, "high");
  assert.deepEqual(systemicHigh.lanes, ["systemic"]);

  const systemicExtreme = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, mark: 1_000, oi: 1_060_000, volume: 100_000_000 }),
    snapshot({ mark: 1_000, oi: 1_000_000, volume: 100_000_000 }),
  );
  assert.equal(systemicExtreme.oiQuantityDeltaUsd, 60_000_000);
  assert.equal(systemicExtreme.severity, "extreme");
  assert.deepEqual(systemicExtreme.lanes, ["systemic"]);
});

test("liquidity gates and contractions stay non-events", () => {
  const thinOi = derive(
    "5m",
    snapshot({ ts: 1_800_000_300_000, mark: 1, oi: 6_000_000, volume: 20_000_000 }),
    snapshot({ mark: 1, oi: 5_000_000, volume: 20_000_000 }),
  );
  assert.equal(thinOi.severity, null);

  const thinVolume = derive(
    "5m",
    snapshot({ ts: 1_800_000_300_000, oi: 1_100_000, volume: 4_999_999 }),
    snapshot({ oi: 1_000_000, volume: 4_999_999 }),
  );
  assert.equal(thinVolume.severity, null);

  const contraction = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, oi: 800_000 }),
    snapshot({ oi: 1_000_000 }),
  );
  assert.equal(contraction.oiCoinsChangePct, -20);
  assert.equal(contraction.quadrant, "contracting_flat");
  assert.equal(contraction.severity, null);
  assert.deepEqual(contraction.lanes, []);
});

test("price dead-zone preserves expanding-flat compression semantics", () => {
  const flat = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, mark: 100.05, oi: 1_080_000 }),
    snapshot({ mark: 100, oi: 1_000_000 }),
  );
  assert.equal(flat.quadrant, "expanding_flat");

  const down = derive(
    "15m",
    snapshot({ ts: 1_800_000_900_000, mark: 99, oi: 1_080_000 }),
    snapshot({ mark: 100, oi: 1_000_000 }),
  );
  assert.equal(down.quadrant, "expanding_down");
});

test("invalid or mismatched snapshot inputs are rejected", () => {
  assert.equal(deriveOiSurgeObservation({
    symbol: "BAD",
    horizon: "15m",
    current: snapshot({ oi: null }),
    prior: snapshot(),
    displayScale: 1,
  }), null);
  assert.equal(deriveOiSurgeObservation({
    symbol: "BAD",
    horizon: "15m",
    current: snapshot(),
    prior: snapshot({ oi: 0 }),
    displayScale: 1,
  }), null);
  assert.equal(deriveOiSurgeObservation({
    symbol: "BAD",
    horizon: "15m",
    current: snapshot(),
    prior: snapshot(),
    displayScale: 0,
  }), null);
});

test("horizon evidence rejects snapshots outside the configured lookback tolerance", () => {
  const currentAt = 1_800_000_900_000;
  const current = snapshot({ ts: currentAt, oi: 1_100_000 });
  for (const priorTs of [currentAt - 10 * 60_000, currentAt - 19 * 60_000]) {
    assert.equal(deriveOiSurgeObservation({
      symbol: "BTC",
      horizon: "15m",
      current,
      prior: snapshot({ ts: priorTs, oi: 1_000_000 }),
      displayScale: 1,
    }), null);
  }
});

test("persistence is required per horizon and merges confirmed horizons", () => {
  const previousAt = 1_800_000_840_000;
  const currentAt = previousAt + 60_000;
  const previous5m = derive(
    "5m",
    snapshot({ ts: previousAt, oi: 1_060_000 }),
    snapshot({ ts: previousAt - 5 * 60_000, oi: 1_000_000 }),
  );
  const current5m = derive(
    "5m",
    snapshot({ ts: currentAt, oi: 1_080_000 }),
    snapshot({ ts: currentAt - 5 * 60_000, oi: 1_000_000 }),
  );
  const previous15m = derive(
    "15m",
    snapshot({ ts: previousAt, oi: 1_080_000 }),
    snapshot({ ts: previousAt - 15 * 60_000, oi: 1_000_000 }),
  );
  const current15m = derive(
    "15m",
    snapshot({ ts: currentAt, oi: 1_120_000 }),
    snapshot({ ts: currentAt - 15 * 60_000, oi: 1_000_000 }),
  );

  assert.equal(selectPersistentOiSurgeDetection([current5m], [], 120_000), null);

  const detection = selectPersistentOiSurgeDetection(
    [current5m, current15m],
    [previous5m, previous15m],
    120_000,
  );
  assert.ok(detection);
  assert.equal(detection.symbol, "TEST");
  assert.equal(detection.detectedAt, currentAt);
  assert.equal(detection.severity, "extreme");
  assert.deepEqual(detection.horizons, ["5m", "15m"]);
  assert.deepEqual(detection.lanes, ["relative"]);
  assert.equal(detection.observations.length, 2);

  const onlyFiveMinuteConfirmed = selectPersistentOiSurgeDetection(
    [current5m, current15m],
    [previous5m],
    120_000,
  );
  assert.ok(onlyFiveMinuteConfirmed);
  assert.deepEqual(onlyFiveMinuteConfirmed.horizons, ["5m"]);
  assert.equal(onlyFiveMinuteConfirmed.severity, "high");
});

test("persistence rejects stale confirmation snapshots and symbol mismatches", () => {
  const previous = derive(
    "5m",
    snapshot({ ts: 1_800_000_000_000, oi: 1_060_000 }),
    snapshot({ ts: 1_799_999_700_000, oi: 1_000_000 }),
  );
  const current = derive(
    "5m",
    snapshot({ ts: 1_800_000_600_000, oi: 1_080_000 }),
    snapshot({ ts: 1_800_000_300_000, oi: 1_000_000 }),
  );
  assert.equal(selectPersistentOiSurgeDetection([current], [previous], 120_000), null);

  const differentSymbol = { ...previous, symbol: "OTHER" };
  assert.equal(selectPersistentOiSurgeDetection([current], [differentSymbol], 120_000), null);
});

test("latest OI surge map preserves the newest thread for each symbol", () => {
  const map = latestOiSurgeEventsBySymbol([
    { id: 2, symbol: "BTC", lastDetectedAt: 200 },
    { id: 1, symbol: "BTC", lastDetectedAt: 100 },
    { id: 3, symbol: "ETH", lastDetectedAt: 150 },
  ]);
  assert.equal(map.get("BTC")?.id, 2);
  assert.equal(map.get("ETH")?.id, 3);
});

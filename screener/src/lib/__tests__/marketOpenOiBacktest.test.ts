import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeMarketOpenOiBacktest,
  type MarketOpenOiBacktestObservation,
} from "../marketOpenOiBacktest";

function observation(
  cohort: MarketOpenOiBacktestObservation["cohort"],
  returnPct: number,
): MarketOpenOiBacktestObservation {
  return {
    cohort,
    region: "us",
    universe: "crypto",
    quadrant: "expanding_up",
    horizon: "4h",
    returnPct,
    absReturnPct: Math.abs(returnPct),
    continuationReturnPct: returnPct,
  };
}

test("backtest suppresses descriptive metrics for inadequate groups", () => {
  const summary = summarizeMarketOpenOiBacktest([
    observation("selected-open", 1),
    observation("selected-open", -1),
  ], 5);

  assert.equal(summary.length, 1);
  assert.equal(summary[0].n, 2);
  assert.equal(summary[0].requested, 2);
  assert.equal(summary[0].complete, true);
  assert.equal(summary[0].adequateSample, false);
  assert.equal(summary[0].meanReturnPct, null);
  assert.equal(summary[0].positiveContinuationRate, null);
});

test("backtest suppresses metrics when an otherwise adequate group is incomplete", () => {
  const missing = observation("selected-open", 0);
  missing.returnPct = null;
  missing.absReturnPct = null;
  missing.continuationReturnPct = null;
  const [summary] = summarizeMarketOpenOiBacktest([
    ...Array.from({ length: 5 }, () => observation("selected-open", 1)),
    missing,
  ], 5);

  assert.deepEqual(
    { n: summary.n, requested: summary.requested, missing: summary.missing, complete: summary.complete },
    { n: 5, requested: 6, missing: 1, complete: false },
  );
  assert.equal(summary.adequateSample, false);
  assert.equal(summary.meanReturnPct, null);
});

test("backtest keeps selected, eligible-open, and deterministic-control cohorts distinct", () => {
  const observations = [
    ...Array.from({ length: 5 }, () => observation("selected-open", 2)),
    ...Array.from({ length: 5 }, () => observation("eligible-open", 1)),
    ...Array.from({ length: 5 }, () => observation("selected-control+2h", -1)),
  ];
  const summary = summarizeMarketOpenOiBacktest(observations, 5);

  assert.deepEqual(summary.map((row) => row.cohort), [
    "eligible-open",
    "selected-control+2h",
    "selected-open",
  ]);
  assert.ok(summary.every((row) => row.adequateSample));
  assert.equal(summary.find((row) => row.cohort === "selected-open")?.positiveContinuationRate, 1);
});

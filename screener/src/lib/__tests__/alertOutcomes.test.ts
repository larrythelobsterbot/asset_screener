import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAlertOutcome } from "../alertOutcomes";

const base = {
  entry: 100,
  stop: 95,
  target: 110,
  alertAt: 10 * 60_000,
  now: 20 * 60_000,
  snapshots: [],
  candles: [],
};

test("long alert resolves target when a post-alert observation reaches the target", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    snapshots: [{ ts: 11 * 60_000, high: 110, low: 99, mark: 108 }],
  });
  assert.deepEqual(result, { status: "target", resolvedAt: 11 * 60_000, exitPrice: 110, rMultiple: 2 });
});

test("long alert resolves stop from a post-alert observation", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    snapshots: [{ ts: 11 * 60_000, high: 101, low: 95, mark: 96 }],
  });
  assert.deepEqual(result, { status: "stop", resolvedAt: 11 * 60_000, exitPrice: 95, rMultiple: -1 });
});

test("short alert resolves target and stop with reversed boundaries", () => {
  const target = evaluateAlertOutcome({
    ...base,
    direction: "short",
    stop: 105,
    target: 90,
    snapshots: [{ ts: 11 * 60_000, high: 101, low: 90, mark: 92 }],
  });
  const stop = evaluateAlertOutcome({
    ...base,
    direction: "short",
    stop: 105,
    target: 90,
    snapshots: [{ ts: 12 * 60_000, high: 105, low: 99, mark: 104 }],
  });
  assert.deepEqual(target, { status: "target", resolvedAt: 11 * 60_000, exitPrice: 90, rMultiple: 2 });
  assert.deepEqual(stop, { status: "stop", resolvedAt: 12 * 60_000, exitPrice: 105, rMultiple: -1 });
});

test("a single evidence interval touching both boundaries is ambiguous", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    snapshots: [{ ts: 11 * 60_000, high: 110, low: 95 }],
  });
  assert.deepEqual(result, { status: "ambiguous", resolvedAt: 11 * 60_000 });
});

test("same-timestamp candle and snapshot hits are coalesced before resolution", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: 0,
    now: 2 * HOUR,
    snapshots: [{ ts: HOUR, high: 110, low: 99, mark: 108 }],
    candles: [{ ts: HOUR, high: 101, low: 95, close: 96 }],
  });
  assert.deepEqual(result, { status: "ambiguous", resolvedAt: HOUR });
});

test("directionally invalid trade geometry is untrackable", () => {
  const invalidLong = evaluateAlertOutcome({
    ...base,
    direction: "long",
    stop: 101,
  });
  const invalidShort = evaluateAlertOutcome({
    ...base,
    direction: "short",
    stop: 105,
    target: 101,
  });
  assert.equal(invalidLong.status, "untrackable");
  assert.equal(invalidShort.status, "untrackable");
});

test("opening partial snapshots are used, but the alert candle itself is not treated as a full candle", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: 10 * 60_000 + 59 * 60_000,
    now: 2 * HOUR,
    snapshots: [{ ts: 10 * 60_000 + 59 * 60_000 + 30_000, high: 110, low: 99 }],
    candles: [{ ts: HOUR, high: 111, low: 99, close: 108 }],
  });
  assert.equal(result.status, "target");
  assert.equal(result.resolvedAt, 10 * 60_000 + 59 * 60_000 + 30_000);
});

test("the first full one-hour candle after the alert can resolve the outcome", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: 10 * 60_000,
    now: HOUR + 5 * 60_000,
    candles: [{ ts: HOUR, high: 111, low: 99, close: 108 }],
  });
  assert.deepEqual(result, { status: "target", resolvedAt: HOUR, exitPrice: 110, rMultiple: 2 });
});

test("an alert exactly on the hour includes the candle that opens at the alert time", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: HOUR,
    now: 2 * HOUR,
    expiresAt: 49 * HOUR,
    candles: [{ ts: HOUR, high: 111, low: 99, close: 110 }],
  });
  assert.equal(result.status, "target");
});

test("post-opening snapshots can resolve an expiry-hour tail without using post-expiry candle data", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: 10 * 60_000,
    expiresAt: 48 * HOUR + 10 * 60_000,
    now: 49 * HOUR,
    snapshots: [{ ts: 48 * HOUR + 5 * 60_000, high: 110, low: 108, mark: 110 }],
    candles: [],
  });
  assert.deepEqual(result, {
    status: "target",
    resolvedAt: 48 * HOUR + 5 * 60_000,
    exitPrice: 110,
    rMultiple: 2,
  });
});

test("expiry uses the freshest valid mark and computes mark-to-market R", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: 0,
    now: 48 * HOUR,
    candles: [
      { ts: 30 * HOUR, high: 104, low: 102, close: 103 },
      { ts: 40 * HOUR, high: 107, low: 105, close: 106 },
    ],
  });
  assert.deepEqual(result, { status: "expired", resolvedAt: 40 * HOUR, exitPrice: 106, rMultiple: 1.2 });
});

test("missing evidence remains open before expiry", () => {
  const result = evaluateAlertOutcome({ ...base, direction: "long" });
  assert.deepEqual(result, { status: "open" });
});

test("missing evidence after expiry is untrackable rather than a fabricated expiry result", () => {
  const result = evaluateAlertOutcome({
    ...base,
    direction: "long",
    alertAt: 0,
    now: 49 * HOUR,
    expiresAt: 48 * HOUR,
  });
  assert.deepEqual(result, { status: "untrackable", resolvedAt: 48 * HOUR });
});

test("missing trade-card levels are untrackable", () => {
  const result = evaluateAlertOutcome({ ...base, direction: "long", target: null });
  assert.deepEqual(result, { status: "untrackable" });
});

test("terminal outcomes are stable when re-evaluated with later evidence", () => {
  const first = evaluateAlertOutcome({
    ...base,
    direction: "long",
    snapshots: [{ ts: 11 * 60_000, high: 110, low: 99 }],
  });
  const second = evaluateAlertOutcome({
    ...base,
    direction: "long",
    snapshots: [{ ts: 11 * 60_000, high: 110, low: 99 }, { ts: 12 * 60_000, high: 101, low: 95 }],
    existingOutcome: first,
  });
  assert.deepEqual(second, first);
});

const HOUR = 60 * 60 * 1000;

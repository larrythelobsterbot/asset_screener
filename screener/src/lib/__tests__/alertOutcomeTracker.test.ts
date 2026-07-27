import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyAlertOutcomeTrackerHealth,
  createAlertOutcomeScheduler,
  evaluateAllAlertOutcomes,
  evaluateOpenTargetCounterfactuals,
  evaluateOpenTelegramAlerts,
  type AlertOutcomeTrackerDeps,
  type TargetCounterfactualTrackerDeps,
} from "../alertOutcomeTracker";
import type {
  OpenTargetCounterfactualRow,
  TargetCounterfactualOutcomeUpdate,
  TelegramAlertRow,
  TelegramOutcomeUpdate,
} from "../db";

const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<TelegramAlertRow> = {}): TelegramAlertRow {
  return {
    id: 1,
    created_at: 10 * 60_000,
    delivery_status: "delivered",
    delivered_at: 10 * 60_000,
    delivery_error: null,
    delivery_uncertain: 0 as const,
    telegram_message_id: "123",
    symbol: "BTC",
    sector: "crypto majors",
    direction: "long",
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 1,
    risk_usd: 5,
    conviction_score: 4,
    conviction_json: "{}",
    signal_json: "[]",
    family_json: "[]",
    expires_at: 48 * 60 * 60 * 1000,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
    ...overrides,
  };
}

test("tracker resolves opening-hour targets from scaled snapshot marks", async () => {
  const updates: TelegramOutcomeUpdate[] = [];
  const deps: AlertOutcomeTrackerDeps = {
    listOpen: () => [row()],
    snapshots: () => [{ ts: 11 * 60_000, mark: 115 }],
    candles: () => [],
    displayScale: () => 1,
    update: (_id, update) => { updates.push(update); return true; },
    now: () => 20 * 60_000,
  };

  const report = await evaluateOpenTelegramAlerts(deps);
  assert.equal(report.scanned, 1);
  assert.equal(report.updated, 1);
  assert.equal(report.errors, 0);
  assert.equal(updates[0].outcome_status, "target");
  assert.equal(updates[0].pnl_r, 3);
});

test("tracker marks a delivered alert without a confirmed delivery timestamp untrackable", async () => {
  const updates: TelegramOutcomeUpdate[] = [];
  let evidenceRead = false;
  const deps: AlertOutcomeTrackerDeps = {
    listOpen: () => [row({ delivered_at: null })],
    snapshots: () => { evidenceRead = true; return [{ ts: 11 * 60_000, mark: 115 }]; },
    candles: () => { evidenceRead = true; return []; },
    displayScale: () => 1,
    update: (_id, update) => { updates.push(update); return true; },
    now: () => 20 * 60_000,
  };

  const report = await evaluateOpenTelegramAlerts(deps);
  assert.deepEqual(report, {
    scanned: 1,
    updated: 1,
    open: 0,
    errors: 0,
    reconciledUnknown: 0,
  });
  assert.equal(evidenceRead, false);
  assert.equal(updates[0].outcome_status, "untrackable");
  assert.equal(updates[0].outcome_note, "confirmed Telegram delivery timestamp unavailable");
  assert.equal(updates[0].outcome_provenance, "delivery");
});

test("counterfactual tracker evaluates the 1.5R target without mutating the live alert", async () => {
  const updates: TargetCounterfactualOutcomeUpdate[] = [];
  const counterfactual: OpenTargetCounterfactualRow = {
    id: 10,
    alert_id: 1,
    policy_version: "target-1_5r-v1",
    target_r: 1.5,
    target_price: 107.5,
    expires_at: 48 * HOUR,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
    created_at: 0,
    updated_at: 0,
    symbol: "BTC",
    direction: "long",
    entry_price: 100,
    stop_price: 95,
    delivered_at: 0,
  };
  const deps: TargetCounterfactualTrackerDeps = {
    ensure: () => 1,
    listOpen: () => [counterfactual],
    snapshots: () => [],
    candles: () => [{ symbol: "BTC", interval: "1h", t: HOUR, o: 100, h: 108, l: 99, c: 107.5, v: 1 }],
    displayScale: () => 1,
    update: (_id, update) => { updates.push(update); return true; },
    now: () => 2 * HOUR,
  };

  const report = await evaluateOpenTargetCounterfactuals(deps);
  assert.deepEqual(report, { seeded: 1, scanned: 1, updated: 1, open: 0, errors: 0 });
  assert.equal(updates[0].outcome_status, "target");
  assert.equal(updates[0].outcome_price, 107.5);
  assert.equal(updates[0].pnl_r, 1.5);
});

test("combined evaluator reports live and counterfactual lifecycle work separately", async () => {
  const liveDeps: AlertOutcomeTrackerDeps = {
    listOpen: () => [],
    snapshots: () => [],
    candles: () => [],
    displayScale: () => 1,
    update: () => true,
    now: () => 10_000,
  };
  const counterfactualDeps: TargetCounterfactualTrackerDeps = {
    ensure: () => 3,
    listOpen: () => [],
    snapshots: () => [],
    candles: () => [],
    displayScale: () => 1,
    update: () => true,
    now: () => 10_000,
  };

  const report = await evaluateAllAlertOutcomes(liveDeps, counterfactualDeps);
  assert.equal(report.scanned, 0);
  assert.deepEqual(report.counterfactual, { seeded: 3, scanned: 0, updated: 0, open: 0, errors: 0 });
});

test("tracker scales raw Hyperliquid candles before comparing display-price levels", async () => {
  const updates: TelegramOutcomeUpdate[] = [];
  const deps: AlertOutcomeTrackerDeps = {
    listOpen: () => [row({ symbol: "SPX", created_at: 0, delivered_at: 0 })],
    snapshots: () => [],
    candles: () => [{ symbol: "SPX", interval: "1h", t: 60 * 60 * 1000, o: 0.005, h: 0.006, l: 0.0048, c: 0.0058, v: 1 }],
    displayScale: () => 20_000,
    update: (_id, update) => { updates.push(update); return true; },
    now: () => 2 * 60 * 60 * 1000,
  };

  await evaluateOpenTelegramAlerts(deps);
  assert.equal(updates[0].outcome_status, "target");
  assert.equal(updates[0].outcome_price, 115);
});

test("tracker queries the candle opening at an exact-hour delivery timestamp", async () => {
  const updates: TelegramOutcomeUpdate[] = [];
  const deps: AlertOutcomeTrackerDeps = {
    listOpen: () => [row({ created_at: HOUR, delivered_at: HOUR, expires_at: 49 * HOUR })],
    snapshots: () => [],
    candles: (_symbol, _interval, from) => from <= HOUR
      ? [{ symbol: "BTC", interval: "1h", t: HOUR, o: 100, h: 116, l: 99, c: 115, v: 1 }]
      : [],
    displayScale: () => 1,
    update: (_id, update) => { updates.push(update); return true; },
    now: () => 2 * HOUR,
  };

  const report = await evaluateOpenTelegramAlerts(deps);
  assert.equal(report.updated, 1);
  assert.equal(updates[0].outcome_status, "target");
});

test("expired replay uses snapshots for the final partial hour and excludes post-expiry candle highs", async () => {
  const HOUR = 60 * 60 * 1000;
  const updates: TelegramOutcomeUpdate[] = [];
  const alertAt = 10 * 60_000;
  const expiresAt = 48 * HOUR + alertAt;
  const deps: AlertOutcomeTrackerDeps = {
    listOpen: () => [row({ created_at: alertAt, delivered_at: alertAt, expires_at: expiresAt })],
    snapshots: (_symbol, from, to) =>
      from <= 48 * HOUR + 5 * 60_000 && to >= 48 * HOUR + 5 * 60_000
        ? [{ ts: 48 * HOUR + 5 * 60_000, mark: 115 }]
        : [],
    candles: (_symbol, _interval, from, to) =>
      from <= 48 * HOUR && to >= 48 * HOUR
        ? [{ symbol: "BTC", interval: "1h", t: 48 * HOUR, o: 100, h: 200, l: 1, c: 100, v: 1 }]
        : [],
    displayScale: () => 1,
    update: (_id, update) => { updates.push(update); return true; },
    now: () => 49 * HOUR,
  };

  await evaluateOpenTelegramAlerts(deps);
  assert.equal(updates[0].outcome_status, "target");
  assert.equal(updates[0].outcome_at, 48 * HOUR + 5 * 60_000);
});

test("tracker isolates one alert failure and continues evaluating the batch", async () => {
  const updatedIds: number[] = [];
  const deps: AlertOutcomeTrackerDeps = {
    listOpen: () => [row({ id: 1, symbol: "BAD" }), row({ id: 2, symbol: "GOOD" })],
    snapshots: (symbol) => {
      if (symbol === "BAD") throw new Error("snapshot lookup failed");
      return [{ ts: 11 * 60_000, mark: 95 }];
    },
    candles: () => [],
    displayScale: () => 1,
    update: (id) => { updatedIds.push(id); return true; },
    now: () => 20 * 60_000,
  };

  const report = await evaluateOpenTelegramAlerts(deps);
  assert.equal(report.scanned, 2);
  assert.equal(report.updated, 1);
  assert.equal(report.errors, 1);
  assert.deepEqual(updatedIds, [2]);
});

test("scheduler coalesces concurrent kicks and enforces its minimum interval", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let now = 100_000;
  const scheduler = createAlertOutcomeScheduler(async () => {
    calls += 1;
    await gate;
    return { scanned: 0, updated: 0, open: 0, errors: 0, reconciledUnknown: 0 };
  }, 60_000, () => now);

  const first = scheduler.kick();
  const concurrent = scheduler.kick();
  assert.equal(first, concurrent);
  assert.equal(calls, 1);
  release();
  await first;

  assert.equal(scheduler.kick(), null);
  now += 60_000;
  await scheduler.kick();
  assert.equal(calls, 2);
  assert.equal(scheduler.getState().lastSuccessfulAt, now);
});

test("tracker health becomes stale when successful evaluation cadence stops", () => {
  const state = {
    running: false,
    lastRunAt: 1_000,
    lastSuccessfulAt: 1_000,
    lastDurationMs: 10,
    lastError: null,
    scanned: 0,
    updated: 0,
    open: 0,
    errors: 0,
    reconciledUnknown: 0,
  };
  assert.equal(classifyAlertOutcomeTrackerHealth(state, 120_000, 0).status, "healthy");
  const stale = classifyAlertOutcomeTrackerHealth(state, 301_001, 0);
  assert.equal(stale.status, "stale");
  assert.equal(stale.stale, true);
});

test("evaluation reconciles stale pending delivery attempts before scanning outcomes", async () => {
  const calls: Array<[number, number]> = [];
  const now = 20 * 60_000;
  const report = await evaluateOpenTelegramAlerts({
    listOpen: () => [],
    snapshots: () => [],
    candles: () => [],
    displayScale: () => 1,
    update: () => false,
    reconcilePending: (cutoff, observedAt) => { calls.push([cutoff, observedAt]); return 2; },
    now: () => now,
  });
  assert.deepEqual(calls, [[10 * 60_000, now]]);
  assert.equal(report.reconciledUnknown, 2);
});

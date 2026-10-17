import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  NewOiSurgeEvent,
  OiSurgeEventRow,
  OiSurgeOutcomeRow,
  PendingOiSurgeOutcomeEvent,
  SnapshotPointFull,
} from "../db";
import {
  createOiSurgeScheduler,
  scanOiSurges,
  selectOiSurgePilotCandidate,
  type OiSurgePilotEligibilityDeps,
  type OiSurgeScannerDeps,
  type OiSurgeTickReport,
} from "../oiSurgeService";
import {
  evaluateOiSurgeOutcomes,
  type OiSurgeOutcomeTrackerDeps,
} from "../oiSurgeOutcomeTracker";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function point(
  ts: number,
  overrides: Partial<SnapshotPointFull> = {},
): SnapshotPointFull {
  return {
    ts,
    mark: 100,
    oi: 1_000_000,
    funding: 0.0001,
    volume: 50_000_000,
    ...overrides,
  };
}

test("scanner requires consecutive bounded evidence and persists one merged detection", () => {
  const anchor = 1_900_000_000_000;
  const maps = new Map<number, Map<string, SnapshotPointFull>>([
    [anchor, new Map([["BTC", point(anchor, { mark: 102, oi: 1_120_000 })]])],
    [anchor - MINUTE_MS, new Map([["BTC", point(anchor - MINUTE_MS, { mark: 101, oi: 1_100_000 })]])],
    [anchor - 15 * MINUTE_MS, new Map([["BTC", point(anchor - 15 * MINUTE_MS)]])],
    [anchor - 16 * MINUTE_MS, new Map([["BTC", point(anchor - 16 * MINUTE_MS)]])],
  ]);
  const reserved: NewOiSurgeEvent[] = [];
  const currentExtremeCandidates: number[] = [];
  const deps: OiSurgeScannerDeps = {
    latest: () => new Map([["BTC", {
      symbol: "BTC",
      ts: anchor,
      mark: 102,
      prev_day: null,
      funding: 0.0001,
      oi: 1_120_000,
      volume: 50_000_000,
    }]]),
    snapshot: (targetAt) => maps.get(targetAt) ?? new Map(),
    displayScale: () => 1,
    sector: () => "majors",
    reserve: (event) => {
      reserved.push(event);
      return { kind: "inserted", id: 1 };
    },
    onReserved: (event, reservation) => {
      if (event.severity === "extreme") currentExtremeCandidates.push(reservation.id);
    },
    now: () => anchor + 30_000,
  };

  const report = scanOiSurges(deps);
  assert.deepEqual(report, {
    status: "ok",
    anchorAt: anchor,
    scanned: 1,
    confirmed: 1,
    inserted: 1,
    updated: 0,
    errors: 0,
  });
  assert.equal(reserved.length, 1);
  assert.equal(reserved[0].symbol, "BTC");
  assert.equal(reserved[0].source, "hyperliquid");
  assert.equal(reserved[0].severity, "extreme");
  assert.equal(reserved[0].primary_horizon, "15m");
  assert.deepEqual(reserved[0].horizons, ["15m"]);
  assert.deepEqual(reserved[0].lanes, ["relative"]);
  assert.equal(reserved[0].entry_mark, 102);
  assert.equal(reserved[0].oi_coins_change_pct, 12);
  assert.equal(reserved[0].oi_quantity_delta_usd, 12_000_000);
  assert.deepEqual(currentExtremeCandidates, [1], "only current-scan reservations become delivery candidates");
});

test("pilot eligibility excludes pre-pilot threads but preserves pilot high-to-extreme escalation", () => {
  let mode: "shadow" | "extreme-pilot" = "shadow";
  let eligibleAt: number | null = null;
  const event = (severity: "high" | "extreme"): NewOiSurgeEvent => ({
    policy_version: "oi-surge-shadow-v1",
    source: "hyperliquid",
    symbol: "BTC",
    sector: "majors",
    detected_at: 1_900_000_000_000,
    severity,
    primary_horizon: "15m",
    quadrant: "expanding_up",
    entry_mark: 100_000,
    entry_oi_usd: 1_000_000_000,
    oi_coins_change_pct: 12,
    oi_quantity_delta_usd: 60_000_000,
    price_change_pct: 2,
    volume_24h: 500_000_000,
    funding_hourly: 0.0001,
    horizons: ["15m"],
    lanes: ["relative"],
    evidence: {},
    observed_at: 1_900_000_001_000,
  });
  const deps: OiSurgePilotEligibilityDeps = {
    mode: () => mode,
    markEligible: (_id, at) => {
      if (eligibleAt != null || at == null) return false;
      eligibleAt = at;
      return true;
    },
    getEvent: () => ({ severity: "extreme", pilot_eligible_at: eligibleAt } as OiSurgeEventRow),
  };

  assert.equal(selectOiSurgePilotCandidate(event("extreme"), { kind: "inserted", id: 1 }, deps), null);
  mode = "extreme-pilot";
  assert.equal(selectOiSurgePilotCandidate(event("extreme"), { kind: "updated", id: 1 }, deps), null);
  assert.equal(selectOiSurgePilotCandidate(event("high"), { kind: "inserted", id: 2 }, deps), null);
  assert.equal(eligibleAt, event("high").observed_at);
  assert.equal(selectOiSurgePilotCandidate(event("extreme"), { kind: "updated", id: 2 }, deps), 2);
});

test("scanner does not persist a one-print spike or stale current data", () => {
  const anchor = 1_910_000_000_000;
  const maps = new Map<number, Map<string, SnapshotPointFull>>([
    [anchor, new Map([["ONE", point(anchor, { oi: 1_120_000 })]])],
    [anchor - MINUTE_MS, new Map([["ONE", point(anchor - MINUTE_MS, { oi: 1_010_000 })]])],
    [anchor - 15 * MINUTE_MS, new Map([["ONE", point(anchor - 15 * MINUTE_MS)]])],
    [anchor - 16 * MINUTE_MS, new Map([["ONE", point(anchor - 16 * MINUTE_MS)]])],
  ]);
  let writes = 0;
  const baseDeps: OiSurgeScannerDeps = {
    latest: () => new Map([["ONE", {
      symbol: "ONE",
      ts: anchor,
      mark: 100,
      prev_day: null,
      funding: 0,
      oi: 1_120_000,
      volume: 50_000_000,
    }]]),
    snapshot: (targetAt) => maps.get(targetAt) ?? new Map(),
    displayScale: () => 1,
    sector: () => "crypto-alt",
    reserve: () => {
      writes += 1;
      return { kind: "inserted", id: 1 };
    },
    now: () => anchor + 30_000,
  };

  const onePrint = scanOiSurges(baseDeps);
  assert.equal(onePrint.status, "ok");
  assert.equal(onePrint.confirmed, 0);
  assert.equal(writes, 0);

  const stale = scanOiSurges({ ...baseDeps, now: () => anchor + 3 * MINUTE_MS });
  assert.equal(stale.status, "stale");
  assert.equal(stale.confirmed, 0);
  assert.equal(writes, 0);
});

test("scanner reports empty history as warming rather than an error", () => {
  const report = scanOiSurges({
    latest: () => new Map(),
    snapshot: () => new Map(),
    displayScale: () => 1,
    sector: () => "crypto-alt",
    reserve: () => ({ kind: "inserted", id: 1 }),
    now: () => 1_920_000_000_000,
  });
  assert.equal(report.status, "warming");
  assert.equal(report.anchorAt, null);
  assert.equal(report.errors, 0);
});

test("outcome tracker writes bounded 1h/4h/24h descriptive returns", () => {
  const start = 1_930_000_000_000;
  const subject: PendingOiSurgeOutcomeEvent = {
    eventId: 7,
    symbol: "BTC",
    startedAt: start,
    entryMark: 100,
  };
  const inserted: OiSurgeOutcomeRow[] = [];
  const deps: OiSurgeOutcomeTrackerDeps = {
    listPending: () => [subject],
    listExisting: () => [],
    snapshot: (targetAt) => {
      const marks = new Map([
        [start + HOUR_MS, 105],
        [start + 4 * HOUR_MS, 95],
        [start + 24 * HOUR_MS, 110],
      ]);
      const mark = marks.get(targetAt);
      return mark == null ? new Map() : new Map([["BTC", point(targetAt, { mark })]]);
    },
    series: (_symbol, _fromAt, toAt) => {
      const paths = new Map([
        [start + HOUR_MS, [100, 110, 95, 105]],
        [start + 4 * HOUR_MS, [100, 102, 90, 95]],
        [start + 24 * HOUR_MS, [100, 120, 80, 110]],
      ]);
      return (paths.get(toAt) ?? []).map((mark, index) => ({ ts: start + index * MINUTE_MS, mark }));
    },
    insert: (row) => {
      inserted.push(row);
      return true;
    },
    now: () => start + 25 * HOUR_MS,
  };

  const report = evaluateOiSurgeOutcomes(deps);
  assert.deepEqual(report, { scanned: 1, inserted: 3, missing: 0, untrackable: 0, errors: 0 });
  assert.deepEqual(inserted.map((row) => [
    row.horizon,
    row.return_pct,
    row.abs_return_pct,
    row.high_return_pct,
    row.low_return_pct,
  ]), [
    ["1h", 5, 5, 10, -5],
    ["4h", -5, 5, 2, -10],
    ["24h", 10, 10, 20, -20],
  ]);
});

test("outcome tracker records missing evidence once and skips existing horizons", () => {
  const start = 1_940_000_000_000;
  const inserted: OiSurgeOutcomeRow[] = [];
  const existing: OiSurgeOutcomeRow = {
    event_id: 8,
    horizon: "1h",
    target_at: start + HOUR_MS,
    status: "observed",
    snapshot_at: start + HOUR_MS,
    mark: 101,
    return_pct: 1,
    abs_return_pct: 1,
    high_return_pct: 3,
    low_return_pct: -2,
    observed_at: start + 2 * HOUR_MS,
    note: null,
  };
  const report = evaluateOiSurgeOutcomes({
    listPending: () => [{ eventId: 8, symbol: "MISS", startedAt: start, entryMark: 100 }],
    listExisting: () => [existing],
    snapshot: () => new Map(),
    insert: (row) => {
      inserted.push(row);
      return true;
    },
    now: () => start + 5 * HOUR_MS,
  });
  assert.deepEqual(report, { scanned: 1, inserted: 1, missing: 1, untrackable: 0, errors: 0 });
  assert.deepEqual(inserted.map((row) => row.horizon), ["4h"]);
  assert.equal(inserted[0].status, "missing");
});

test("scheduler is single-flight and enforces the minimum interval", async () => {
  let resolveRun: ((value: OiSurgeTickReport) => void) | null = null;
  let calls = 0;
  let now = 10_000;
  const report: OiSurgeTickReport = {
    scan: {
      status: "ok",
      anchorAt: 9_000,
      scanned: 1,
      confirmed: 0,
      inserted: 0,
      updated: 0,
      errors: 0,
    },
    outcomes: { scanned: 0, inserted: 0, missing: 0, untrackable: 0, errors: 0 },
    delivery: {
      mode: "shadow",
      candidates: 0,
      shadowed: 0,
      ineligible: 0,
      duplicate: 0,
      delivered: 0,
      failed: 0,
      unknown: 0,
      errors: 0,
      recovery: {
        mode: "shadow",
        reconciledUnknown: 0,
        resumed: 0,
        expired: 0,
        delivered: 0,
        failed: 0,
        unknown: 0,
      },
    },
  };
  const scheduler = createOiSurgeScheduler(() => {
    calls += 1;
    return new Promise<OiSurgeTickReport>((resolve) => { resolveRun = resolve; });
  }, 60_000, () => now);
  const settleRun = () => {
    const resolver = resolveRun as ((value: OiSurgeTickReport) => void) | null;
    assert.ok(resolver);
    resolver(report);
    resolveRun = null;
  };

  const first = scheduler.kick();
  assert.ok(first);
  assert.equal(scheduler.kick(), first, "active run should be shared");
  assert.equal(calls, 1);
  settleRun();
  assert.deepEqual(await first, report);
  assert.equal(scheduler.kick(), null, "completed run remains interval-limited");

  now += 60_000;
  const second = scheduler.kick();
  assert.ok(second);
  assert.equal(calls, 2);
  settleRun();
  await second;
  const state = scheduler.getState();
  assert.equal(state.lastSuccessfulAt, now);
  assert.deepEqual(state.lastReport, report);
});

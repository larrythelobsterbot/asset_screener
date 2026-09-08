import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getOiSurgeEvent,
  listLatestOiSurgeEventsBySymbol,
  listOiSurgeDeliveries,
  listOiSurgeEvents,
  listOiSurgeOutcomes,
  listPendingOiSurgeDeliveries,
  listPendingOiSurgeOutcomeEvents,
  markOiSurgeDeliveryAttempted,
  markOiSurgeDeliveryDelivered,
  markOiSurgeDeliveryExpired,
  markOiSurgeEventPilotEligible,
  reconcileStaleAttemptedOiSurgeDeliveries,
  reserveOiSurgeDelivery,
  reserveOiSurgeEvent,
  summarizeOiSurgeDeliveries,
  summarizeOiSurgeEvents,
  upsertOiSurgeOutcome,
  type NewOiSurgeEvent,
} from "../db";

const HOUR_MS = 60 * 60_000;

function eventInput(overrides: Partial<NewOiSurgeEvent> = {}): NewOiSurgeEvent {
  const detectedAt = overrides.detected_at ?? 1_800_000_000_000;
  return {
    policy_version: "oi-surge-shadow-v1",
    source: "hyperliquid",
    symbol: "BTC",
    sector: "majors",
    detected_at: detectedAt,
    severity: "high",
    primary_horizon: "15m",
    quadrant: "expanding_up",
    entry_mark: 100,
    entry_oi_usd: 100_000_000,
    oi_coins_change_pct: 8,
    oi_quantity_delta_usd: 8_000_000,
    price_change_pct: 2,
    volume_24h: 50_000_000,
    funding_hourly: 0.0001,
    horizons: ["15m"],
    lanes: ["relative"],
    evidence: { version: 1, currentTs: detectedAt, marker: "initial" },
    observed_at: detectedAt + 1_000,
    ...overrides,
  };
}

test("OI surge reservation inserts then upgrades one four-hour event thread", () => {
  const first = reserveOiSurgeEvent(eventInput(), 4 * HOUR_MS);
  assert.equal(first.kind, "inserted");

  const updatedAt = 1_800_000_060_000;
  const second = reserveOiSurgeEvent(eventInput({
    detected_at: updatedAt,
    severity: "extreme",
    primary_horizon: "5m",
    quadrant: "expanding_flat",
    oi_coins_change_pct: 12,
    oi_quantity_delta_usd: 60_000_000,
    price_change_pct: 0.05,
    horizons: ["5m", "15m"],
    lanes: ["relative", "systemic"],
    evidence: { version: 1, currentTs: updatedAt, marker: "upgrade" },
    observed_at: updatedAt + 1_000,
  }), 4 * HOUR_MS);
  assert.equal(second.kind, "updated");
  assert.equal(second.id, first.id);

  const rows = listOiSurgeEvents({ limit: 10 });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.severity, "extreme");
  assert.equal(row.source, "hyperliquid");
  assert.equal(row.started_at, 1_800_000_000_000);
  assert.equal(row.last_detected_at, updatedAt);
  assert.equal(row.primary_horizon, "5m");
  assert.equal(row.latest_quadrant, "expanding_flat");
  assert.equal(row.max_oi_coins_change_pct, 12);
  assert.equal(row.max_quantity_delta_usd, 60_000_000);
  assert.deepEqual(JSON.parse(row.horizons_json), ["5m", "15m"]);
  assert.deepEqual(JSON.parse(row.lanes_json), ["relative", "systemic"]);
  assert.equal(JSON.parse(row.initial_evidence_json).marker, "initial");
  assert.equal(JSON.parse(row.latest_evidence_json).marker, "upgrade");
});

test("OI surge reservation creates a new event after the thread window", () => {
  const base = 1_810_000_000_000;
  const first = reserveOiSurgeEvent(eventInput({ symbol: "ETH", detected_at: base }), 4 * HOUR_MS);
  const second = reserveOiSurgeEvent(eventInput({
    symbol: "ETH",
    detected_at: base + 4 * HOUR_MS + 1,
    observed_at: base + 4 * HOUR_MS + 2,
  }), 4 * HOUR_MS);
  assert.equal(first.kind, "inserted");
  assert.equal(second.kind, "inserted");
  assert.notEqual(second.id, first.id);
  assert.equal(listOiSurgeEvents({ symbol: "ETH", limit: 10 }).length, 2);
});

test("OI surge recent-map and summary are bounded by time", () => {
  const base = 1_820_000_000_000;
  reserveOiSurgeEvent(eventInput({ symbol: "MAPA", detected_at: base, severity: "high" }), 4 * HOUR_MS);
  reserveOiSurgeEvent(eventInput({ symbol: "MAPB", detected_at: base + 1_000, severity: "extreme" }), 4 * HOUR_MS);
  reserveOiSurgeEvent(eventInput({ symbol: "OLD", detected_at: base - 10 * HOUR_MS }), 4 * HOUR_MS);

  const recent = listLatestOiSurgeEventsBySymbol(base - HOUR_MS, ["MAPA", "MAPB", "OLD"]);
  assert.equal(recent.size, 2);
  assert.equal(recent.get("MAPB")?.severity, "extreme");
  assert.equal(recent.get("OLD"), undefined);

  const summary = summarizeOiSurgeEvents(base - HOUR_MS);
  assert.deepEqual(summary, { total: 2, high: 1, extreme: 1 });
});

test("OI surge outcomes are idempotent and pending subjects close after 24h", () => {
  const base = 1_830_000_000_000;
  const reserved = reserveOiSurgeEvent(eventInput({ symbol: "OUT", detected_at: base }), 4 * HOUR_MS);
  assert.equal(
    listPendingOiSurgeOutcomeEvents(base + 30 * 60_000, 100).some((row) => row.eventId === reserved.id),
    false,
  );
  assert.equal(
    listPendingOiSurgeOutcomeEvents(base + HOUR_MS + 10 * 60_000, 100).some((row) => row.eventId === reserved.id),
    true,
  );

  const first = upsertOiSurgeOutcome({
    event_id: reserved.id,
    horizon: "1h",
    target_at: base + HOUR_MS,
    status: "observed",
    snapshot_at: base + HOUR_MS,
    mark: 105,
    return_pct: 5,
    abs_return_pct: 5,
    high_return_pct: 8,
    low_return_pct: -3,
    observed_at: base + HOUR_MS + 10 * 60_000,
    note: null,
  });
  assert.equal(first, true);
  assert.equal(upsertOiSurgeOutcome({
    event_id: reserved.id,
    horizon: "1h",
    target_at: base + HOUR_MS,
    status: "observed",
    snapshot_at: base + HOUR_MS,
    mark: 999,
    return_pct: 899,
    abs_return_pct: 899,
    high_return_pct: 900,
    low_return_pct: -10,
    observed_at: base + HOUR_MS + 11 * 60_000,
    note: null,
  }), false);

  for (const [horizon, hours] of [["4h", 4], ["24h", 24]] as const) {
    assert.equal(upsertOiSurgeOutcome({
      event_id: reserved.id,
      horizon,
      target_at: base + hours * HOUR_MS,
      status: "missing",
      snapshot_at: null,
      mark: null,
      return_pct: null,
      abs_return_pct: null,
      high_return_pct: null,
      low_return_pct: null,
      observed_at: base + hours * HOUR_MS + 10 * 60_000,
      note: "fixture gap",
    }), true);
  }

  const outcomes = listOiSurgeOutcomes(reserved.id);
  assert.deepEqual(outcomes.map((row) => row.horizon), ["1h", "4h", "24h"]);
  assert.equal(outcomes[0].mark, 105, "conflicting re-evaluation must not overwrite immutable evidence");
  assert.equal(
    listPendingOiSurgeOutcomeEvents(base + 25 * HOUR_MS, 100).some((row) => row.eventId === reserved.id),
    false,
  );
});

test("OI surge delivery reservation is extreme-only and idempotent", () => {
  const base = 1_840_000_000_000;
  const high = reserveOiSurgeEvent(eventInput({ symbol: "HIGH", detected_at: base }), 4 * HOUR_MS);
  assert.deepEqual(
    reserveOiSurgeDelivery(high.id, "high body", "extreme-pilot", base + 1_000),
    { kind: "ineligible", eventId: high.id },
  );

  const extreme = reserveOiSurgeEvent(eventInput({
    symbol: "XTRM",
    detected_at: base + 2_000,
    severity: "extreme",
  }), 4 * HOUR_MS);
  assert.deepEqual(
    reserveOiSurgeDelivery(extreme.id, "pre-pilot body", "extreme-pilot", base + 2_500),
    { kind: "ineligible", eventId: extreme.id },
    "a pre-pilot shadow event must never be backfilled",
  );
  assert.equal(markOiSurgeEventPilotEligible(extreme.id, base + 2_750), true);
  assert.equal(markOiSurgeEventPilotEligible(extreme.id, base + 2_800), false);
  assert.equal(getOiSurgeEvent(extreme.id)?.pilot_eligible_at, base + 2_750);
  assert.deepEqual(
    reserveOiSurgeDelivery(extreme.id, "persisted extreme body", "extreme-pilot", base + 3_000),
    { kind: "inserted", eventId: extreme.id },
  );
  assert.deepEqual(
    reserveOiSurgeDelivery(extreme.id, "different body", "extreme-pilot", base + 4_000),
    { kind: "duplicate", eventId: extreme.id },
  );
  assert.equal(markOiSurgeDeliveryAttempted(extreme.id, base + 5_000), true);
  assert.equal(markOiSurgeDeliveryDelivered(extreme.id, "tg-42", base + 6_000), true);

  const rows = listOiSurgeDeliveries({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_body, "persisted extreme body");
  assert.equal(rows[0].delivery_status, "delivered");
  assert.equal(rows[0].telegram_message_id, "tg-42");
  assert.deepEqual(summarizeOiSurgeDeliveries(), {
    total: 1, pending: 0, delivered: 1, failed: 0, unknown: 0, expired: 0,
  });
  assert.deepEqual(summarizeOiSurgeDeliveries(base + 4_000), {
    total: 0, pending: 0, delivered: 0, failed: 0, unknown: 0, expired: 0,
  });
});

test("OI surge pending delivery recovery never retries an attempted message", () => {
  const base = 1_850_000_000_000;
  const pending = reserveOiSurgeEvent(eventInput({
    symbol: "PEND",
    detected_at: base,
    severity: "extreme",
  }), 4 * HOUR_MS);
  markOiSurgeEventPilotEligible(pending.id, base + 500);
  reserveOiSurgeDelivery(pending.id, "pending body", "extreme-pilot", base + 1_000);
  assert.deepEqual(listPendingOiSurgeDeliveries(10).map((row) => row.event_id), [pending.id]);
  assert.equal(markOiSurgeDeliveryAttempted(pending.id, base + 2_000), true);
  assert.equal(reconcileStaleAttemptedOiSurgeDeliveries(base + 3_000, base + 4_000), 1);
  assert.equal(listOiSurgeDeliveries({ eventId: pending.id })[0].delivery_status, "unknown");

  const stale = reserveOiSurgeEvent(eventInput({
    symbol: "STALE",
    detected_at: base + 5_000,
    severity: "extreme",
  }), 4 * HOUR_MS);
  markOiSurgeEventPilotEligible(stale.id, base + 5_500);
  reserveOiSurgeDelivery(stale.id, "stale body", "extreme-pilot", base + 6_000);
  assert.equal(markOiSurgeDeliveryExpired(stale.id, "send window elapsed", base + 7_000), true);
  assert.equal(listOiSurgeDeliveries({ eventId: stale.id })[0].delivery_status, "expired");
});

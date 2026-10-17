import { test } from "node:test";
import assert from "node:assert/strict";

import type { OiSurgeDeliveryRow, OiSurgeEventRow } from "../db";
import {
  deliverExtremeOiSurgeEvent,
  formatOiSurgeTelegram,
  getOiSurgeAlertMode,
  resumeOiSurgeDeliveries,
  type OiSurgeDeliveryDeps,
  type OiSurgeRecoveryDeps,
} from "../oiSurgeDelivery";

function eventRow(overrides: Partial<OiSurgeEventRow> = {}): OiSurgeEventRow {
  return {
    id: 7,
    policy_version: "oi-surge-shadow-v1",
    source: "hyperliquid",
    mode: "shadow",
    symbol: "BTC",
    sector: "majors",
    started_at: 1_900_000_000_000,
    last_detected_at: 1_900_000_060_000,
    severity: "extreme",
    primary_horizon: "15m",
    entry_mark: 100_000,
    entry_oi_usd: 1_000_000_000,
    latest_quadrant: "expanding_up",
    max_oi_coins_change_pct: 12,
    max_quantity_delta_usd: 60_000_000,
    latest_price_change_pct: 2,
    volume_24h: 500_000_000,
    funding_hourly: 0.0001,
    horizons_json: '["5m","15m"]',
    lanes_json: '["relative","systemic"]',
    initial_evidence_json: "{}",
    latest_evidence_json: "{}",
    created_at: 1_900_000_060_000,
    updated_at: 1_900_000_060_000,
    pilot_eligible_at: 1_900_000_060_000,
    ...overrides,
  };
}

test("OI surge alert mode fails closed unless extreme-pilot is exact", () => {
  assert.equal(getOiSurgeAlertMode({}), "shadow");
  assert.equal(getOiSurgeAlertMode({ OI_SURGE_ALERT_MODE: "extreme-pilot" }), "extreme-pilot");
  assert.equal(getOiSurgeAlertMode({ OI_SURGE_ALERT_MODE: "live" }), "shadow");
  assert.equal(getOiSurgeAlertMode({ OI_SURGE_ALERT_MODE: "EXTREME-PILOT" }), "shadow");
});

test("extreme Telegram copy is escaped, contextual, and explicitly non-directional", () => {
  const body = formatOiSurgeTelegram(eventRow({ symbol: "<BTC&" }));
  assert.match(body, /EXTREME OI SURGE/);
  assert.match(body, /&lt;BTC&amp;/);
  assert.match(body, /5m · 15m/);
  assert.match(body, /\+12\.0%/);
  assert.match(body, /\+\$60\.0M/);
  assert.match(body, /Price \+2\.0%/);
  assert.match(body, /not a trade signal/i);
  assert.ok(body.length <= 4_096);
});

function baseDeliveryDeps(overrides: Partial<OiSurgeDeliveryDeps> = {}): OiSurgeDeliveryDeps {
  return {
    mode: () => "extreme-pilot",
    reserve: (eventId) => ({ kind: "inserted", eventId }),
    markAttempted: () => true,
    send: async () => ({ ok: true, messageId: 42 }),
    markDelivered: () => true,
    markFailed: () => true,
    markUnknown: () => true,
    now: () => 1_900_000_120_000,
    ...overrides,
  };
}

test("delivery fails closed in shadow and excludes high severity", async () => {
  let reservations = 0;
  let sends = 0;
  const deps = baseDeliveryDeps({
    mode: () => "shadow",
    reserve: (eventId) => {
      reservations += 1;
      return { kind: "inserted", eventId };
    },
    send: async () => {
      sends += 1;
      return { ok: true, messageId: 1 };
    },
  });
  assert.equal(await deliverExtremeOiSurgeEvent(eventRow(), deps), "shadow");
  deps.mode = () => "extreme-pilot";
  assert.equal(await deliverExtremeOiSurgeEvent(eventRow({ severity: "high" }), deps), "ineligible");
  assert.equal(reservations, 0);
  assert.equal(sends, 0);
});

test("extreme delivery reserves before send and never sends a duplicate", async () => {
  const order: string[] = [];
  let reserved = false;
  const deps = baseDeliveryDeps({
    reserve: (eventId, body) => {
      order.push("reserve");
      assert.match(body, /EXTREME OI SURGE/);
      if (reserved) return { kind: "duplicate", eventId };
      reserved = true;
      return { kind: "inserted", eventId };
    },
    markAttempted: () => { order.push("attempt"); return true; },
    send: async () => { order.push("send"); return { ok: true, messageId: 42 }; },
    markDelivered: (_id, messageId) => {
      order.push("delivered");
      assert.equal(messageId, "42");
      return true;
    },
  });

  assert.equal(await deliverExtremeOiSurgeEvent(eventRow(), deps), "delivered");
  assert.equal(await deliverExtremeOiSurgeEvent(eventRow(), deps), "duplicate");
  assert.deepEqual(order, ["reserve", "attempt", "send", "delivered", "reserve"]);
});

test("ambiguous Telegram failures are terminal unknown, not retryable", async () => {
  let unknown = "";
  const deps = baseDeliveryDeps({
    send: async () => ({ ok: false, error: "network timeout", failureKind: "unknown" }),
    markUnknown: (_id, error) => { unknown = error; return true; },
  });
  assert.equal(await deliverExtremeOiSurgeEvent(eventRow(), deps), "unknown");
  assert.match(unknown, /network timeout/);
});

test("recovery resumes fresh unattempted rows and expires stale ones", async () => {
  const now = 1_900_001_000_000;
  const row = (eventId: number, createdAt: number): OiSurgeDeliveryRow => ({
    event_id: eventId,
    alert_mode: "extreme-pilot",
    message_body: `body ${eventId}`,
    delivery_status: "pending",
    delivery_attempted_at: null,
    delivered_at: null,
    telegram_message_id: null,
    delivery_error: null,
    created_at: createdAt,
    updated_at: createdAt,
  });
  const expired: number[] = [];
  const recovery: OiSurgeRecoveryDeps = {
    ...baseDeliveryDeps({ now: () => now }),
    listPending: () => [row(1, now - 60_000), row(2, now - 16 * 60_000)],
    reconcile: () => 1,
    markExpired: (eventId) => { expired.push(eventId); return true; },
  };
  const result = await resumeOiSurgeDeliveries(recovery);
  assert.deepEqual(result, {
    mode: "extreme-pilot",
    reconciledUnknown: 1,
    resumed: 1,
    expired: 1,
    delivered: 1,
    failed: 0,
    unknown: 0,
  });
  assert.deepEqual(expired, [2]);
});

test("shadow recovery reconciles and expires stale rows without sending", async () => {
  const now = 1_900_002_000_000;
  let sends = 0;
  const expired: number[] = [];
  const recovery: OiSurgeRecoveryDeps = {
    ...baseDeliveryDeps({
      mode: () => "shadow",
      now: () => now,
      send: async () => {
        sends += 1;
        return { ok: true, messageId: 1 };
      },
    }),
    listPending: () => [{
      event_id: 3,
      alert_mode: "extreme-pilot",
      message_body: "stale shadow body",
      delivery_status: "pending",
      delivery_attempted_at: null,
      delivered_at: null,
      telegram_message_id: null,
      delivery_error: null,
      created_at: now - 16 * 60_000,
      updated_at: now - 16 * 60_000,
    }],
    reconcile: () => 1,
    markExpired: (eventId) => { expired.push(eventId); return true; },
  };
  const result = await resumeOiSurgeDeliveries(recovery);
  assert.deepEqual(result, {
    mode: "shadow",
    reconciledUnknown: 1,
    resumed: 0,
    expired: 1,
    delivered: 0,
    failed: 0,
    unknown: 0,
  });
  assert.equal(sends, 0);
  assert.deepEqual(expired, [3]);
});

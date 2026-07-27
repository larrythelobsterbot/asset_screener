import { test } from "node:test";
import assert from "node:assert/strict";

import { marketOpenScheduleForDate } from "../marketOpenOiCalendar";
import {
  isMarketOpenOiEnabled,
  isMarketOpenOiShadowEnabled,
  runMarketOpenOiTick,
  startMarketOpenOiTick,
  type MarketOpenOiSchedulerDeps,
} from "../marketOpenOiScheduler";

const outcome = { scanned: 0, inserted: 0, missing: 0, errors: 0 };

function deps(overrides: Partial<MarketOpenOiSchedulerDeps> = {}): MarketOpenOiSchedulerDeps {
  return {
    enabled: () => false,
    shadowEnabled: () => false,
    telegramConfigured: () => true,
    dueSessions: () => [],
    build: () => ({ status: "suppressed", reason: "insufficient_assets" }),
    deliver: async () => "delivered",
    persistShadow: () => "shadowed",
    recover: async () => ({ reconciledUnknown: 0, resumed: 0, expired: 0, delivered: 0, failed: 0, unknown: 0 }),
    evaluate: () => outcome,
    now: () => Date.parse("2026-07-27T13:00:00Z"),
    minIntervalMs: 0,
    ...overrides,
  };
}

test("feature flag is explicit and defaults off", () => {
  assert.equal(isMarketOpenOiEnabled({}), false);
  assert.equal(isMarketOpenOiEnabled({ MARKET_OPEN_OI_ENABLED: "true" }), true);
  assert.equal(isMarketOpenOiEnabled({ MARKET_OPEN_OI_ENABLED: "1" }), false);
  assert.equal(isMarketOpenOiShadowEnabled({}), false);
  assert.equal(isMarketOpenOiShadowEnabled({ MARKET_OPEN_OI_SHADOW_ENABLED: "true" }), true);
});

test("disabled tick evaluates existing outcomes but cannot generate or deliver", async () => {
  const events: string[] = [];
  const result = await runMarketOpenOiTick(deps({
    evaluate: () => { events.push("evaluate"); return outcome; },
    build: () => { events.push("build"); return { status: "suppressed", reason: "insufficient_assets" }; },
    deliver: async () => { events.push("deliver"); return "delivered"; },
  }));
  assert.deepEqual(events, ["evaluate"]);
  assert.equal(result.status, "disabled");
});

test("shadow-only tick persists a due report without Telegram delivery work", async () => {
  const schedule = marketOpenScheduleForDate("us", "2026-07-27");
  const events: string[] = [];
  const result = await runMarketOpenOiTick(deps({
    shadowEnabled: () => true,
    dueSessions: () => [schedule],
    build: () => ({
      status: "ready",
      report: {
        report_key: schedule.key, region: "us", local_date: schedule.localDate,
        report_at: schedule.reportAt, open_at: schedule.openAt, generated_at: schedule.reportAt,
        lookback_ms: 4 * 60 * 60_000, calendar_covered: 1,
        selection_config_json: "{}", message_body: "body",
      },
      items: [], selection: { crypto: [], equity: [] }, body: "body",
    }),
    persistShadow: () => { events.push("shadow"); return "shadowed"; },
    recover: async () => { throw new Error("shadow mode must not recover delivery"); },
    deliver: async () => { throw new Error("shadow mode must not send"); },
  }));
  assert.deepEqual(events, ["shadow"]);
  assert.equal(result.status, "shadow");
  assert.equal(result.shadowed, 1);
  assert.equal(result.delivered, 0);
});

test("enabled due tick recovers first, builds once, and delivers the ready report", async () => {
  const schedule = marketOpenScheduleForDate("us", "2026-07-27");
  const events: string[] = [];
  const result = await runMarketOpenOiTick(deps({
    enabled: () => true,
    dueSessions: () => [schedule],
    recover: async () => {
      events.push("recover");
      return { reconciledUnknown: 0, resumed: 0, expired: 0, delivered: 0, failed: 0, unknown: 0 };
    },
    build: () => {
      events.push("build");
      return {
        status: "ready",
        report: {
          report_key: schedule.key, region: "us", local_date: schedule.localDate,
          report_at: schedule.reportAt, open_at: schedule.openAt, generated_at: schedule.reportAt,
          lookback_ms: 4 * 60 * 60_000, calendar_covered: 1,
          selection_config_json: "{}", message_body: "body",
        },
        items: [], selection: { crypto: [], equity: [] }, body: "body",
      };
    },
    deliver: async () => { events.push("deliver"); return "delivered"; },
    evaluate: () => { events.push("evaluate"); return outcome; },
  }));
  assert.deepEqual(events, ["evaluate", "recover", "build", "deliver"]);
  assert.equal(result.status, "ok");
  assert.equal(result.delivered, 1);
});

test("missing Telegram configuration blocks all external delivery work", async () => {
  const events: string[] = [];
  const result = await runMarketOpenOiTick(deps({
    enabled: () => true,
    telegramConfigured: () => false,
    recover: async () => { events.push("recover"); throw new Error("must not run"); },
    evaluate: () => { events.push("evaluate"); return outcome; },
  }));
  assert.deepEqual(events, ["evaluate"]);
  assert.equal(result.status, "blocked");
});

test("outcome evaluator failures remain visible in tick health", async () => {
  const result = await runMarketOpenOiTick(deps({
    shadowEnabled: () => true,
    evaluate: () => { throw new Error("outcome db unavailable"); },
  }));
  assert.equal(result.outcomes.errors, 1);
  assert.match(result.errors.join(" "), /outcome db unavailable/);
});

test("tick starter coalesces overlapping requests", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controlled = deps({
    evaluate: () => outcome,
    enabled: () => true,
    recover: async () => {
      await gate;
      return { reconciledUnknown: 0, resumed: 0, expired: 0, delivered: 0, failed: 0, unknown: 0 };
    },
  });
  const first = startMarketOpenOiTick(controlled);
  assert.ok(first);
  assert.equal(startMarketOpenOiTick(controlled), null);
  release();
  await first;
  const third = startMarketOpenOiTick(deps());
  assert.ok(third);
  await third;
});

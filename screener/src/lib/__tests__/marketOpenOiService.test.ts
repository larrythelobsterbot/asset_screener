import { test } from "node:test";
import assert from "node:assert/strict";
import type { AssetData } from "../types";

import { marketOpenScheduleForDate } from "../marketOpenOiCalendar";
import {
  buildMarketOpenOiPreview,
  computeMarketOpenOiSmartFlowDeltas,
  deliverMarketOpenOiPreview,
  marketOpenOiAssetsFromMarkets,
  persistShadowMarketOpenOiPreview,
  resumeMarketOpenOiDeliveries,
  type MarketOpenOiBuildDeps,
} from "../marketOpenOiService";

const zeroGates = {
  crypto: { minCurrentOiUsd: 0, minVolume24h: 0, minAbsOiPct: 0, minAbsQuantityDeltaUsd: 0 },
  equity: { minCurrentOiUsd: 0, minVolume24h: 0, minAbsOiPct: 0, minAbsQuantityDeltaUsd: 0 },
  maxPerUniverse: 5,
};

test("source assets preserve the exact sector assigned by the markets builder", () => {
  const assets = marketOpenOiAssetsFromMarkets([
    { symbol: "SKHX", sector: "stocks", source: "hyperliquid" } as AssetData,
    { symbol: "BTC", sector: "majors", source: "hyperliquid" } as AssetData,
    { symbol: "IGNORED", sector: "stocks", source: "coingecko" } as AssetData,
  ]);
  assert.deepEqual(assets.map(({ symbol, sector }) => ({ symbol, sector })), [
    { symbol: "SKHX", sector: "stocks" },
    { symbol: "BTC", sector: "majors" },
  ]);
});

test("builds a report from bounded same-row current and four-hour snapshots", () => {
  const schedule = marketOpenScheduleForDate("us", "2026-07-27");
  const calls: number[] = [];
  const currentAt = schedule.reportAt;
  const priorAt = currentAt - 4 * 60 * 60_000;
  const deps: MarketOpenOiBuildDeps = {
    assets: () => [
      { symbol: "BTC", sector: "majors", displayScale: 1 },
      { symbol: "ETH", sector: "majors", displayScale: 1 },
      { symbol: "GOLD", sector: "commodities", displayScale: 1 },
    ],
    snapshots: (target) => {
      calls.push(target);
      if (target === currentAt) return new Map([
        ["BTC", { ts: currentAt - 1_000, mark: 110, oi: 120, funding: 0.0001, volume: 20_000_000 }],
        ["ETH", { ts: currentAt - 1_000, mark: 210, oi: 220, funding: -0.0001, volume: 15_000_000 }],
      ]);
      return new Map([
        ["BTC", { ts: priorAt - 1_000, mark: 100, oi: 100, funding: 0, volume: 18_000_000 }],
        ["ETH", { ts: priorAt - 1_000, mark: 200, oi: 200, funding: 0, volume: 14_000_000 }],
      ]);
    },
    smartFlowDeltas: () => new Map([["BTC", 500_000]]),
  };

  const preview = buildMarketOpenOiPreview(schedule, currentAt, zeroGates, deps);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.deepEqual(calls, [currentAt, priorAt]);
  assert.deepEqual(preview.selection.crypto.map((item) => item.symbol), ["ETH", "BTC"]);
  assert.equal(preview.selection.equity.length, 0);
  assert.match(preview.body, /BTC/);
  assert.equal(preview.items.length, 2);
  assert.equal(preview.report.report_key, "us:2026-07-27");
});

test("suppressed preview discloses snapshot-stage denominators", () => {
  const schedule = marketOpenScheduleForDate("us", "2026-07-27");
  const priorAt = schedule.reportAt - 4 * 60 * 60_000;
  const point = { ts: schedule.reportAt, mark: 100, oi: 100, funding: 0, volume: 10_000_000 };
  const preview = buildMarketOpenOiPreview(schedule, schedule.reportAt, zeroGates, {
    assets: () => [
      { symbol: "BTC", sector: "majors", displayScale: 1 },
      { symbol: "ETH", sector: "majors", displayScale: 1 },
      { symbol: "SOL", sector: "majors", displayScale: 1 },
    ],
    snapshots: (target) => target === schedule.reportAt
      ? new Map([
        ["BTC", point],
        ["ETH", point],
      ])
      : new Map([
        ["BTC", { ...point, ts: priorAt }],
        ["SOL", { ...point, ts: priorAt }],
      ]),
    smartFlowDeltas: () => new Map(),
  });

  assert.deepEqual(preview, {
    status: "suppressed",
    reason: "insufficient_snapshots",
    diagnostics: {
      stage: "snapshots",
      requestedAssets: 3,
      currentSnapshots: 2,
      priorSnapshots: 2,
      pairedSnapshots: 1,
      missingCurrent: 1,
      missingPrior: 1,
      derivedAssets: 0,
      selectedAssets: 0,
    },
  });
});

test("selection suppression distinguishes valid snapshots from derived eligibility", () => {
  const schedule = marketOpenScheduleForDate("us", "2026-07-27");
  const point = { ts: schedule.reportAt, mark: 100, oi: 100, funding: 0, volume: 10_000_000 };
  const preview = buildMarketOpenOiPreview(schedule, schedule.reportAt, zeroGates, {
    assets: () => [
      { symbol: "BTC", sector: "majors", displayScale: 1 },
      { symbol: "ETH", sector: "majors", displayScale: 1 },
    ],
    snapshots: (target) => new Map([
      ["BTC", { ...point, ts: target, oi: target === schedule.reportAt ? 110 : 100 }],
      ["ETH", { ...point, ts: target, oi: target === schedule.reportAt ? -1 : 100 }],
    ]),
    smartFlowDeltas: () => new Map(),
  });

  assert.deepEqual(preview, {
    status: "suppressed",
    reason: "insufficient_assets",
    diagnostics: {
      stage: "selection",
      requestedAssets: 2,
      currentSnapshots: 2,
      priorSnapshots: 2,
      pairedSnapshots: 2,
      missingCurrent: 0,
      missingPrior: 0,
      derivedAssets: 1,
      selectedAssets: 1,
    },
  });
});

test("smart-flow deltas preserve unknown-history versus known zero-position semantics", () => {
  const point = (netUsd: number) => ({
    longUsd: Math.max(netUsd, 0),
    shortUsd: Math.max(-netUsd, 0),
    netUsd,
    wallets: 1,
  });
  assert.equal(computeMarketOpenOiSmartFlowDeltas(new Map([["BTC", point(10)]]), new Map()).size, 0);

  const deltas = computeMarketOpenOiSmartFlowDeltas(
    new Map([["BTC", point(300)], ["ETH", point(-100)]]),
    new Map([["BTC", point(100)], ["SOL", point(50)]]),
  );
  assert.deepEqual([...deltas.entries()].sort(), [
    ["BTC", 200],
    ["ETH", -100],
    ["SOL", -50],
  ]);

  const fullyClosed = computeMarketOpenOiSmartFlowDeltas(
    new Map(),
    new Map([["SOL", point(50)]]),
    true,
  );
  assert.deepEqual([...fullyClosed.entries()], [["SOL", -50]]);
});

test("delivery reserves durably before the external send and persists acknowledgement", async () => {
  const schedule = marketOpenScheduleForDate("us", "2026-07-28");
  const point = { ts: schedule.reportAt, mark: 100, oi: 110, funding: 0, volume: 10_000_000 };
  const preview = buildMarketOpenOiPreview(schedule, schedule.reportAt, zeroGates, {
    assets: () => [
      { symbol: "BTC", sector: "majors", displayScale: 1 },
      { symbol: "ETH", sector: "majors", displayScale: 1 },
    ],
    snapshots: (target) => new Map([
      ["BTC", { ...point, ts: target, oi: target === schedule.reportAt ? 110 : 100 }],
      ["ETH", { ...point, ts: target, oi: target === schedule.reportAt ? 120 : 100 }],
    ]),
    smartFlowDeltas: () => new Map(),
  });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  const events: string[] = [];
  const result = await deliverMarketOpenOiPreview(preview, {
    reserve: () => { events.push("reserve"); return { kind: "inserted", id: 7 }; },
    markAttempted: () => { events.push("attempt"); return true; },
    send: async () => { events.push("send"); return { ok: true, messageId: 99 }; },
    markDelivered: () => { events.push("delivered"); return true; },
    markFailed: () => false,
    markUnknown: () => false,
    now: () => 123,
  });
  assert.equal(result, "delivered");
  assert.deepEqual(events, ["reserve", "attempt", "send", "delivered"]);
});

test("duplicate reservation never emits a second Telegram message", async () => {
  let sent = false;
  const result = await deliverMarketOpenOiPreview({
    status: "ready",
    report: {
      report_key: "us:2026-07-28", region: "us", local_date: "2026-07-28",
      report_at: 1, open_at: 2, generated_at: 1, lookback_ms: 4 * 60 * 60_000,
      calendar_covered: 1, selection_config_json: "{}", message_body: "body",
    },
    items: [],
    selection: { crypto: [], equity: [] },
    body: "body",
  }, {
    reserve: () => ({ kind: "duplicate", id: 7 }),
    markAttempted: () => false,
    send: async () => { sent = true; return { ok: true, messageId: 99 }; },
    markDelivered: () => false,
    markFailed: () => false,
    markUnknown: () => false,
    now: () => 123,
  });
  assert.equal(result, "duplicate");
  assert.equal(sent, false);
});

test("shadow persistence reserves report evidence without creating a Telegram attempt", () => {
  const calls: unknown[][] = [];
  const preview = {
    status: "ready" as const,
    report: {
      report_key: "us:2026-07-28", region: "us" as const, local_date: "2026-07-28",
      report_at: 1, open_at: 2, generated_at: 1, lookback_ms: 4 * 60 * 60_000,
      calendar_covered: 1 as const, selection_config_json: "{}", message_body: "body",
    },
    items: [], selection: { crypto: [], equity: [] }, body: "body",
  };
  const result = persistShadowMarketOpenOiPreview(preview, {
    reserve: (...args) => { calls.push(args); return { kind: "inserted", id: 7 }; },
  });
  assert.equal(result, "shadowed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], "shadow");
});

test("recovery marks stale attempted rows unknown, expires stale unsent rows, and resumes only current bodies", async () => {
  const events: string[] = [];
  const result = await resumeMarketOpenOiDeliveries({
    reconcile: () => { events.push("reconcile"); return 1; },
    listPending: () => [
      {
        id: 8, report_key: "asia:2026-07-29", region: "asia", local_date: "2026-07-29",
        report_at: 1, open_at: 1_800_001, generated_at: 1, lookback_ms: 4 * 60 * 60_000,
        calendar_covered: 1, selection_config_json: "{}", message_body: "persisted body",
        delivery_status: "pending", delivery_attempted_at: null, delivered_at: null,
        delivery_error: null, telegram_message_id: null, created_at: 1, updated_at: 1,
      },
      {
        id: 9, report_key: "asia:2026-07-28", region: "asia", local_date: "2026-07-28",
        report_at: -400_000, open_at: 1_400_000, generated_at: -400_000,
        lookback_ms: 4 * 60 * 60_000, calendar_covered: 1, selection_config_json: "{}",
        message_body: "stale body", delivery_status: "pending", delivery_attempted_at: null,
        delivered_at: null, delivery_error: null, telegram_message_id: null,
        created_at: -400_000, updated_at: -400_000,
      },
    ],
    reserve: () => ({ kind: "duplicate", id: 8 }),
    markAttempted: () => { events.push("attempt"); return true; },
    send: async (body) => { events.push(`send:${body}`); return { ok: true, messageId: 100 }; },
    markDelivered: () => { events.push("delivered"); return true; },
    markFailed: () => false,
    markUnknown: () => false,
    markExpired: (id) => { events.push(`expired:${id}`); return true; },
    now: () => 300_000,
  });
  assert.deepEqual(events, ["reconcile", "attempt", "send:persisted body", "delivered", "expired:9"]);
  assert.deepEqual(result, {
    reconciledUnknown: 1, resumed: 1, expired: 1, delivered: 1, failed: 0, unknown: 0,
  });
});

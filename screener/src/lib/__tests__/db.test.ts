// DAL round-trip tests. We point the DB at a tmpfile per process and let
// Node's `node --test` runner clean up by process exit. Tests are
// intentionally isolated by using distinct keys/symbols per case so a
// shared DB doesn't cause cross-test interference.

// IMPORTANT: db-test-setup must be the first import — it sets
// SCREENER_DB_PATH before the db module reads it at load time. ES module
// semantics evaluate dependencies in order, so this side effect runs
// first.
import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertPriceSnapshots,
  latestSnapshots,
  snapshotAt,
  snapshotAtBounded,
  priceSnapshotsInRange,
  prunePriceSnapshots,
  upsertCandles,
  getCandlesFromCache,
  candlesInRange,
  loadEventHistory,
  recordEventFire,
  eventHistoryKey,
  loadSignalStates,
  signalStateKey,
  upsertSignalState,
  kvGet,
  kvSet,
  insertSocialSnapshots,
  latestSocialSnapshots,
  pruneSocialSnapshots,
  insertTrade,
  closeTrade,
  listTrades,
  getTrade,
  insertWalletPositions,
  latestWalletPositionTs,
  getDb,
  insertTelegramAlert,
  reserveTelegramAlert,
  markTelegramAlertDelivered,
  markTelegramAlertFailed,
  markTelegramAlertDeliveryUnknown,
  reconcileStalePendingTelegramAlerts,
  listOpenTelegramAlerts,
  updateTelegramAlertOutcome,
  listTelegramAlerts,
  summarizeTelegramAlerts,
  hasActiveTelegramThesis,
  insertAlertCandidate,
  listAlertCandidates,
  markAlertCandidateTelegramAttempted,
  pruneAlertCandidates,
  ensureTargetCounterfactuals,
  listTargetCounterfactuals,
  listOpenTargetCounterfactuals,
  updateTargetCounterfactualOutcome,
  listMarketOpenOiItems,
  listMarketOpenOiReports,
  listMarketOpenOiOutcomes,
  listPendingMarketOpenOiOutcomeItems,
  listPendingMarketOpenOiReports,
  markMarketOpenOiDeliveryAttempted,
  markMarketOpenOiDelivered,
  markMarketOpenOiFailed,
  markMarketOpenOiExpired,
  markMarketOpenOiUnknown,
  reserveMarketOpenOiReport,
  reconcileStaleAttemptedMarketOpenOiReports,
  summarizeMarketOpenOiReports,
  upsertMarketOpenOiOutcome,
} from "../db";

test("price_snapshots round-trip + latestSnapshots returns newest per symbol", () => {
  const now = Date.now();
  insertPriceSnapshots([
    { symbol: "BTC", ts: now - 60_000, mark: 60000, prev_day: 59000, funding: 0.0001, oi: 100, volume: 1e9 },
    { symbol: "BTC", ts: now,          mark: 61000, prev_day: 59000, funding: 0.0002, oi: 110, volume: 1.1e9 },
    { symbol: "ETH", ts: now,          mark: 3000,  prev_day: 2950,  funding: 0.0,    oi: 50,  volume: 2e8 },
  ]);
  const latest = latestSnapshots(["BTC", "ETH"]);
  assert.equal(latest.get("BTC")?.mark, 61000, "BTC should resolve to newest row");
  assert.equal(latest.get("ETH")?.mark, 3000);
});

test("snapshotAt returns the row at or before the target timestamp (with ts)", () => {
  const base = Date.now() + 1_000_000; // shift so we don't collide with prior test
  insertPriceSnapshots([
    { symbol: "SOL", ts: base + 0,       mark: 100, prev_day: 99, funding: 0, oi: 1, volume: 1 },
    { symbol: "SOL", ts: base + 60_000,  mark: 105, prev_day: 99, funding: 0, oi: 1, volume: 1 },
    { symbol: "SOL", ts: base + 120_000, mark: 110, prev_day: 99, funding: 0, oi: 1, volume: 1 },
  ]);
  // Target halfway between t1 and t2 — should return t1's row (mark + ts).
  const m = snapshotAt(base + 90_000, ["SOL"]);
  const row = m.get("SOL");
  assert.equal(row?.mark, 105);
  assert.equal(row?.ts, base + 60_000, "should also return the actual matched ts");
});

test("snapshotAtBounded drops rows older than the tolerance window", () => {
  // Insert a fresh row + an ancient row for the same symbol so we know
  // snapshotAt would return the ancient one if no row is fresh enough.
  const base = Date.now() + 9_000_000;
  insertPriceSnapshots([
    { symbol: "BNDX", ts: base - 50 * 86_400_000, mark: 1, prev_day: null, funding: null, oi: null, volume: null },
  ]);
  // Target = now-ish; tolerance = 30 min. Ancient row is 50 days off the
  // target → must be filtered out.
  const m = snapshotAtBounded(base, 30 * 60_000, ["BNDX"]);
  assert.equal(m.get("BNDX"), undefined, "ancient row should be filtered out by tolerance");

  // Now add a close-enough row and verify it IS returned.
  insertPriceSnapshots([
    { symbol: "BNDX", ts: base - 5 * 60_000, mark: 42, prev_day: null, funding: null, oi: null, volume: null },
  ]);
  const m2 = snapshotAtBounded(base, 30 * 60_000, ["BNDX"]);
  assert.equal(m2.get("BNDX"), 42, "row within tolerance should be returned");
});

test("prunePriceSnapshots removes only rows older than the cutoff", () => {
  // Insert one ancient + one fresh row for a unique symbol so we don't
  // step on other tests' data.
  const now = Date.now();
  insertPriceSnapshots([
    { symbol: "PRUNETEST", ts: now - 1000 * 86_400_000, mark: 1, prev_day: null, funding: null, oi: null, volume: null },
    { symbol: "PRUNETEST", ts: now,                     mark: 2, prev_day: null, funding: null, oi: null, volume: null },
  ]);
  const removed = prunePriceSnapshots(30 * 86_400_000);
  assert.ok(removed >= 1, "expected at least the ancient row to be pruned");
  const latest = latestSnapshots(["PRUNETEST"]);
  assert.equal(latest.get("PRUNETEST")?.mark, 2, "fresh row should survive");
});

test("candles upsert overwrites existing rows on conflict", () => {
  const t = 1_700_000_000_000;
  upsertCandles([{ symbol: "BTC", interval: "4h", t, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }]);
  upsertCandles([{ symbol: "BTC", interval: "4h", t, o: 1, h: 3, l: 0.5, c: 2.0, v: 200 }]);
  const rows = getCandlesFromCache("BTC", "4h", 10);
  const updated = rows.find((r) => r.t === t);
  assert.equal(updated?.c, 2.0, "close should reflect the second upsert");
  assert.equal(updated?.v, 200);
});

test("getCandlesFromCache returns oldest-first slice", () => {
  // Use a fresh symbol/interval to avoid bleed-over with the upsert test.
  const base = 1_800_000_000_000;
  const rows = Array.from({ length: 5 }, (_, i) => ({
    symbol: "TST",
    interval: "1h",
    t: base + i * 3_600_000,
    o: i, h: i, l: i, c: i, v: i,
  }));
  upsertCandles(rows);
  const fetched = getCandlesFromCache("TST", "1h", 3);
  // Should be the *latest* 3, in oldest-first order: i=2, i=3, i=4.
  assert.deepEqual(fetched.map((r) => r.c), [2, 3, 4]);
});

test("event_history persists fire timestamps and survives reload", () => {
  // Same (symbol, type, tf) — second call should overwrite the first.
  recordEventFire("EVTSYM", "rsi_overbought", 1_234_567_890, "4h");
  recordEventFire("EVTSYM", "rsi_overbought", 1_234_567_999, "4h");
  // Different tf — should be a separate row, not collide.
  recordEventFire("EVTSYM", "rsi_overbought", 1_234_000_000, "1d");
  const h = loadEventHistory();
  assert.equal(h.get(eventHistoryKey("EVTSYM", "rsi_overbought", "4h")), 1_234_567_999, "4h latest fire should win");
  assert.equal(h.get(eventHistoryKey("EVTSYM", "rsi_overbought", "1d")), 1_234_000_000, "1d row separate from 4h");
});

test("signal_states durably records activation and hysteresis reset state", () => {
  upsertSignalState({
    symbol: "STATE",
    type: "volume_spike",
    timeframe: "4h",
    active: 1,
    direction: "bullish",
    value: 2.5,
    updated_at: 10_000,
  });
  assert.equal(loadSignalStates().get(signalStateKey("STATE", "volume_spike", "4h"))?.active, 1);

  upsertSignalState({
    symbol: "STATE",
    type: "volume_spike",
    timeframe: "4h",
    active: 0,
    direction: null,
    value: 1.2,
    updated_at: 20_000,
  });
  const reset = loadSignalStates().get(signalStateKey("STATE", "volume_spike", "4h"));
  assert.equal(reset?.active, 0);
  assert.equal(reset?.direction, null);
});

test("social_snapshots round-trip + latestSocialSnapshots returns newest per (symbol, tf)", () => {
  const now = Date.now();
  insertSocialSnapshots([
    { symbol: "BTC", time_window: "24h", ts: now - 3_600_000, mention_count: 1200, prev_count: 1100, change_pct: 9.09 },
    { symbol: "BTC", time_window: "24h", ts: now,             mention_count: 1300, prev_count: 1200, change_pct: 8.33 },
    { symbol: "HYPE", time_window: "24h", ts: now,            mention_count: 800,  prev_count: 600,  change_pct: 33.3 },
  ]);
  const latest = latestSocialSnapshots("24h", ["BTC", "HYPE"]);
  assert.equal(latest.get("BTC")?.mention_count, 1300, "BTC newest should win");
  assert.equal(latest.get("HYPE")?.change_pct, 33.3);
});

test("latestSocialSnapshots: different time windows are scoped separately", () => {
  // Regression test for the audit finding: a 24h snapshot must NOT be
  // returned as a 1h snapshot. Each tf is its own bucket.
  const now = Date.now();
  insertSocialSnapshots([
    { symbol: "TFTEST", time_window: "24h", ts: now, mention_count: 999, prev_count: null, change_pct: null },
    { symbol: "TFTEST", time_window: "1h",  ts: now, mention_count: 42,  prev_count: null, change_pct: null },
  ]);
  assert.equal(latestSocialSnapshots("24h", ["TFTEST"]).get("TFTEST")?.mention_count, 999);
  assert.equal(latestSocialSnapshots("1h",  ["TFTEST"]).get("TFTEST")?.mention_count, 42);
  assert.equal(latestSocialSnapshots("4h",  ["TFTEST"]).get("TFTEST"), undefined, "no row for unrequested tf");
});

test("pruneSocialSnapshots removes only rows older than the cutoff", () => {
  const now = Date.now();
  insertSocialSnapshots([
    { symbol: "PRUNESOCIAL", time_window: "24h", ts: now - 1000 * 86_400_000, mention_count: 1, prev_count: null, change_pct: null },
    { symbol: "PRUNESOCIAL", time_window: "24h", ts: now,                     mention_count: 2, prev_count: null, change_pct: null },
  ]);
  const removed = pruneSocialSnapshots(30 * 86_400_000);
  assert.ok(removed >= 1);
  assert.equal(latestSocialSnapshots("24h", ["PRUNESOCIAL"]).get("PRUNESOCIAL")?.mention_count, 2);
});

test("kv get/set round-trip", () => {
  kvSet("last_scan_ts", "12345");
  assert.equal(kvGet("last_scan_ts"), "12345");
  kvSet("last_scan_ts", "67890");
  assert.equal(kvGet("last_scan_ts"), "67890");
  assert.equal(kvGet("does_not_exist"), null);
});

// ── Integration: signals de-bouncer survives a simulated restart ─────
// We exercise detectSignals through one fire of macd_bullish (which has
// a 24h persistence window), then drop the in-memory cache via the
// test-only reset, and confirm the second call reads the recorded fire
// back from SQLite and refuses to refire.

test("getCandlesFromCache: enforces newest-N-bars ordering for any count <= stored", () => {
  // Insert 50 bars for a fresh symbol; assert that asking for any tail
  // length returns the *latest* bars in oldest-first order.
  const base = 1_900_000_000_000;
  const rows = Array.from({ length: 50 }, (_, i) => ({
    symbol: "TAILSYM",
    interval: "4h",
    t: base + i * 14_400_000,
    o: i, h: i + 1, l: i - 1, c: i + 0.5, v: 1,
  }));
  upsertCandles(rows);

  const last10 = getCandlesFromCache("TAILSYM", "4h", 10);
  assert.equal(last10.length, 10);
  assert.equal(last10[0].t, base + 40 * 14_400_000);
  assert.equal(last10[9].t, base + 49 * 14_400_000);

  const last3 = getCandlesFromCache("TAILSYM", "4h", 3);
  assert.deepEqual(last3.map((r) => r.t), [
    base + 47 * 14_400_000,
    base + 48 * 14_400_000,
    base + 49 * 14_400_000,
  ]);
});

test("eventHistory: same signal type on a different timeframe is NOT suppressed", async () => {
  // Regression test for the audit finding: pre-fix, fireEvent keyed by
  // (symbol, type) only, so a fire on 1h would suppress the same type
  // on 4h+1d for 24h. With the TF-aware key, each timeframe should fire
  // independently.
  const { detectSignals, _resetEventHistoryForTests } = await import("../signals");

  // Series that deterministically forces breakout_up on the last bar.
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < 79; i++) {
    closes.push(100);
    highs.push(100.5);
    lows.push(99.5);
  }
  closes.push(150);
  highs.push(150);
  lows.push(99.5);
  const volumes = closes.map(() => 1000);

  _resetEventHistoryForTests();

  // Fire on 1h — expect breakout_up to land.
  const sig1h = detectSignals("XTFSYM", closes, volumes, highs, lows, undefined, undefined, "1h");
  assert.ok(sig1h.find((s) => s.type === "breakout_up"), "1h should fire");

  // Re-fire on 4h — must NOT be suppressed by the 1h fire.
  const sig4h = detectSignals("XTFSYM", closes, volumes, highs, lows, undefined, undefined, "4h");
  assert.ok(sig4h.find((s) => s.type === "breakout_up"), "4h should also fire (different TF bucket)");

  // And on 1d — same.
  const sig1d = detectSignals("XTFSYM", closes, volumes, highs, lows, undefined, undefined, "1d");
  assert.ok(sig1d.find((s) => s.type === "breakout_up"), "1d should also fire");

  // BUT firing 1h AGAIN should be suppressed (within the persistence window).
  const sig1hAgain = detectSignals("XTFSYM", closes, volumes, highs, lows, undefined, undefined, "1h");
  assert.equal(sig1hAgain.find((s) => s.type === "breakout_up"), undefined, "1h repeat should be suppressed");
});

test("eventHistory: breakout_up does not refire across a simulated restart", async () => {
  const { detectSignals, _resetEventHistoryForTests } = await import("../signals");

  // Build a flat baseline of 80 bars at ~100, then force the LAST bar to
  // be a clean breakout above the prior 20-bar high. breakout_up is one
  // of the persistent-window signal types (24h debounce), so the second
  // call MUST not refire it.
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 0; i < 79; i++) {
    closes.push(100);
    highs.push(100.5);
    lows.push(99.5);
  }
  // Final bar: close way above the prior window high.
  closes.push(150);
  highs.push(150);
  lows.push(99.5);
  const volumes = closes.map(() => 1000);

  _resetEventHistoryForTests();

  const first = detectSignals("RESTARTSYM", closes, volumes, highs, lows);
  const fired = first.find((s) => s.type === "breakout_up");
  assert.ok(fired, `expected breakout_up to fire (got: ${first.map((s) => s.type).join(",") || "none"})`);

  // Simulate restart: drop the in-memory cache so the next call must
  // re-hydrate from SQLite. The recorded fire should still suppress a refire.
  _resetEventHistoryForTests();

  const second = detectSignals("RESTARTSYM", closes, volumes, highs, lows);
  const refired = second.find((s) => s.type === "breakout_up");
  assert.equal(refired, undefined, "breakout_up should not refire after restart");
});

// ── trades journal ──────────────────────────────────────────────────────

test("insertTrade + getTrade round-trip preserves all snapshot fields", () => {
  const id = insertTrade({
    ts_opened: 1700000000000,
    symbol: "BTC",
    sector: "majors",
    direction: "long",
    mode: "paper",
    entry_price: 50000,
    stop_price: 49000,
    target_price: 53000,
    size: 0.04,
    risk_usd: 40,
    conviction_score: 4.2,
    conviction_label: "Strong Buy",
    vol_regime: "normal",
    atr_pct: 1.33,
    funding_hourly: 0.0001,
    signals_json: JSON.stringify([{ type: "breakout_up", tf: "4h" }]),
    families_json: JSON.stringify(["trend", "volume"]),
    notes: null,
  });
  assert.ok(id > 0);

  const row = getTrade(id);
  assert.ok(row);
  assert.equal(row.symbol, "BTC");
  assert.equal(row.direction, "long");
  assert.equal(row.entry_price, 50000);
  assert.equal(row.conviction_score, 4.2);
  assert.equal(row.ts_closed, null);
  assert.equal(row.pnl_usd, null);
});

test("closeTrade @ target: pnl_r is +3R (matches RR_RATIO)", () => {
  const id = insertTrade({
    ts_opened: Date.now(),
    symbol: "ETH",
    sector: "majors",
    direction: "long",
    mode: "paper",
    entry_price: 3000,
    stop_price: 2940,     // stop_dist = 60
    target_price: 3180,   // 3R = 180
    size: 0.667,           // ~$40 risk / $60 stop_dist = 0.667
    risk_usd: 40,
    conviction_score: null,
    conviction_label: null,
    vol_regime: null,
    atr_pct: null,
    funding_hourly: null,
    signals_json: null,
    families_json: null,
    notes: null,
  });
  const closed = closeTrade(id, 3180, "target");
  assert.ok(closed);
  assert.ok(closed.pnl_usd! > 0);
  assert.ok(Math.abs(closed.pnl_r! - 3) < 1e-6, `expected pnl_r ~3, got ${closed.pnl_r}`);
});

test("closeTrade @ stop: short pnl_r is -1R", () => {
  const id = insertTrade({
    ts_opened: Date.now(),
    symbol: "SOL",
    sector: "majors",
    direction: "short",
    mode: "paper",
    entry_price: 200,
    stop_price: 210,    // short stop ABOVE entry, dist = 10
    target_price: 170,  // 3R below = 170
    size: 4,             // $40 / $10 = 4
    risk_usd: 40,
    conviction_score: null,
    conviction_label: null,
    vol_regime: null,
    atr_pct: null,
    funding_hourly: null,
    signals_json: null,
    families_json: null,
    notes: null,
  });
  // Stopped out: exit at 210
  const closed = closeTrade(id, 210, "stop");
  assert.ok(closed);
  assert.ok(closed.pnl_usd! < 0);
  assert.ok(Math.abs(closed.pnl_r! - -1) < 1e-6, `expected pnl_r ~-1, got ${closed.pnl_r}`);
});

test("closeTrade is idempotent — closing twice returns the original close", () => {
  const id = insertTrade({
    ts_opened: Date.now(),
    symbol: "DOGE",
    sector: "majors",
    direction: "long",
    mode: "paper",
    entry_price: 0.1,
    stop_price: 0.09,
    target_price: 0.13,
    size: 400,
    risk_usd: 40,
    conviction_score: null,
    conviction_label: null,
    vol_regime: null,
    atr_pct: null,
    funding_hourly: null,
    signals_json: null,
    families_json: null,
    notes: null,
  });
  const first = closeTrade(id, 0.13, "target");
  const second = closeTrade(id, 0.05, "stop");
  // The second close MUST NOT overwrite the first — that would corrupt
  // the journal. The function returns the existing row unchanged.
  assert.equal(second?.exit_price, first?.exit_price);
  assert.equal(second?.exit_reason, "target");
});

test("listTrades filters by symbol + status", () => {
  // Insert a couple of trades on a unique symbol so this test is
  // isolated from neighbours sharing the DB.
  const sym = "FILTERSYM";
  const open = insertTrade({
    ts_opened: Date.now(),
    symbol: sym,
    sector: "majors",
    direction: "long",
    mode: "paper",
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 8,
    risk_usd: 40,
    conviction_score: null, conviction_label: null,
    vol_regime: null, atr_pct: null, funding_hourly: null,
    signals_json: null, families_json: null, notes: null,
  });
  const closed = insertTrade({
    ts_opened: Date.now() - 1000,
    symbol: sym,
    sector: "majors",
    direction: "long",
    mode: "paper",
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 8,
    risk_usd: 40,
    conviction_score: null, conviction_label: null,
    vol_regime: null, atr_pct: null, funding_hourly: null,
    signals_json: null, families_json: null, notes: null,
  });
  closeTrade(closed, 115, "target");

  const all = listTrades({ symbol: sym, status: "all" });
  assert.equal(all.length, 2);
  const onlyOpen = listTrades({ symbol: sym, status: "open" });
  assert.equal(onlyOpen.length, 1);
  assert.equal(onlyOpen[0].id, open);
  const onlyClosed = listTrades({ symbol: sym, status: "closed" });
  assert.equal(onlyClosed.length, 1);
  assert.equal(onlyClosed[0].id, closed);
});

test("latestWalletPositionTs reports the newest completed wallet snapshot", () => {
  const base = Date.now() + 20_000_000;
  insertWalletPositions([
    { address: "0xhealth-a", ts: base, coin: "BTC", szi: 1, entry_px: 1, position_value: 1, unrealized_pnl: 0, leverage: 1, account_value: 1 },
    { address: "0xhealth-b", ts: base + 1_000, coin: "", szi: 0, entry_px: null, position_value: 0, unrealized_pnl: 0, leverage: null, account_value: 1 },
  ]);
  assert.equal(latestWalletPositionTs(), base + 1_000);
});

test("telegram alert ledger persists lifecycle, outcomes, reads, and indexed migration", () => {
  const now = Date.now() + 30_000_000;
  const id = insertTelegramAlert({
    created_at: now, delivery_status: "pending", delivery_error: null,
    telegram_message_id: null, symbol: "LEDGERSYM", sector: "majors", direction: "long",
    entry_price: 100, stop_price: 90, target_price: 130, size: 4, risk_usd: 40,
    conviction_score: 4.5, conviction_json: JSON.stringify({ score: 4.5 }),
    signal_json: JSON.stringify([{ type: "breakout_up", timeframe: "4h" }]), family_json: JSON.stringify(["trend"]),
    expires_at: now + 48 * 60 * 60 * 1000, outcome_status: "open", outcome_at: null,
    outcome_price: null, pnl_r: null, evaluated_through: null, outcome_note: null, outcome_provenance: null,
  });
  assert.ok(id > 0);
  assert.equal(markTelegramAlertDelivered(id, "tg-123", now + 1_000), true);
  assert.equal(markTelegramAlertDelivered(id, "tg-123", now + 2_000), false);
  assert.equal(listTelegramAlerts({ symbol: "LEDGERSYM", limit: 1 })[0].expires_at, now + 1_000 + 48 * 60 * 60 * 1000);
  assert.equal(listOpenTelegramAlerts(now).length, 1);
  assert.equal(updateTelegramAlertOutcome(id, {
    outcome_status: "target", outcome_at: now + 10_000, outcome_price: 130, pnl_r: 3,
    evaluated_through: now + 10_000, outcome_note: "target touched", outcome_provenance: "one_minute_snapshots",
  }), true);
  assert.equal(updateTelegramAlertOutcome(id, {
    outcome_status: "stop", outcome_at: now + 20_000, outcome_price: 90, pnl_r: -1,
    evaluated_through: now + 20_000, outcome_note: null, outcome_provenance: "late",
  }), false);
  const listed = listTelegramAlerts({ symbol: "LEDGERSYM", outcome_status: "target", limit: 10 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].telegram_message_id, "tg-123");
  assert.equal(summarizeTelegramAlerts({ symbol: "LEDGERSYM" }).target, 1);
  const indexes = getDb().prepare(`select name from sqlite_master where type = 'index'`).all() as Array<{ name: string }>;
  const names = new Set(indexes.map((row) => row.name));
  assert.equal(getDb().pragma("user_version", { simple: true }), 23);
  assert.ok(names.has("idx_telegram_alerts_delivery"));
  assert.ok(names.has("idx_telegram_alerts_outcome"));
  assert.ok(names.has("idx_telegram_alerts_symbol_created"));
  assert.ok(names.has("uq_telegram_alerts_message_id"));
  assert.ok(names.has("idx_alert_candidates_symbol_evaluated"));
  assert.ok(names.has("idx_alert_candidates_version_symbol_evaluated"));
  assert.ok(names.has("idx_alert_counterfactuals_status_expiry"));
  assert.ok(names.has("idx_telegram_alerts_candidate"));
  assert.ok(names.has("idx_telegram_alerts_candidate_attribution"));
  assert.ok(names.has("uq_telegram_alerts_candidate"));
  assert.ok(names.has("uq_market_open_oi_message_id"));
  assert.ok(names.has("idx_market_open_oi_reports_delivery"));
  assert.ok(names.has("idx_market_open_oi_outcomes_target"));
  const candidateColumns = getDb().prepare(`pragma table_info(alert_candidates)`).all() as Array<{ name: string }>;
  assert.ok(candidateColumns.some((column) => column.name === "shadow_policy_json"));
});

test("active Telegram thesis blocks only the same symbol and direction until terminal", () => {
  const now = Date.now() + 33_000_000;
  const id = insertTelegramAlert({
    created_at: now, delivery_status: "pending", delivery_error: null,
    telegram_message_id: null, symbol: "THESIS", sector: null, direction: "long",
    entry_price: 100, stop_price: 95, target_price: 115, size: 1, risk_usd: 5,
    conviction_score: 4, conviction_json: null, signal_json: null, family_json: null,
    expires_at: now + 48 * 60 * 60 * 1000, outcome_status: "open", outcome_at: null,
    outcome_price: null, pnl_r: null, evaluated_through: null, outcome_note: null,
    outcome_provenance: null,
  });
  assert.equal(hasActiveTelegramThesis("THESIS", "long", now), true, "pending attempt blocks a race");
  assert.equal(markTelegramAlertDelivered(id, "thesis-1", now + 1_000), true);
  assert.equal(hasActiveTelegramThesis("THESIS", "long", now + 2_000), true);
  assert.equal(hasActiveTelegramThesis("THESIS", "short", now + 2_000), false);
  assert.equal(hasActiveTelegramThesis("OTHER", "long", now + 2_000), false);
  assert.equal(updateTelegramAlertOutcome(id, {
    outcome_status: "stop", outcome_at: now + 3_000, outcome_price: 95, pnl_r: -1,
    evaluated_through: now + 3_000, outcome_note: "stop", outcome_provenance: "test",
  }), true);
  assert.equal(hasActiveTelegramThesis("THESIS", "long", now + 4_000), false);
});

test("Telegram reservation atomically claims one active symbol and direction", () => {
  const now = Date.now() + 34_000_000;
  const pending = {
    created_at: now,
    delivery_status: "pending" as const,
    delivery_error: null,
    telegram_message_id: null,
    symbol: "ATOMICCLAIM",
    sector: null,
    direction: "long" as const,
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 1,
    risk_usd: 5,
    conviction_score: 4,
    conviction_json: null,
    signal_json: null,
    family_json: null,
    expires_at: now + 48 * 60 * 60 * 1000,
    outcome_status: "open" as const,
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
  };

  const first = reserveTelegramAlert(pending);
  assert.equal(first.kind, "inserted");
  assert.deepEqual(reserveTelegramAlert({ ...pending, created_at: now + 1 }), {
    kind: "blocked",
    reason: "active_thesis",
  });
  assert.equal(reserveTelegramAlert({ ...pending, created_at: now + 2, direction: "short" }).kind, "inserted");
});

test("1.5R target counterfactuals are delivery-relative and terminally immutable", () => {
  const now = Date.now() + 35_000_000;
  const alertId = insertTelegramAlert({
    created_at: now,
    delivery_status: "pending",
    delivery_error: null,
    telegram_message_id: null,
    symbol: "TARGET15R",
    sector: null,
    direction: "long",
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 1,
    risk_usd: 5,
    conviction_score: 4,
    conviction_json: null,
    signal_json: null,
    family_json: null,
    expires_at: now + 48 * 60 * 60 * 1000,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
  });
  const deliveredAt = now + 1_000;
  assert.equal(markTelegramAlertDelivered(alertId, "target-15r", deliveredAt), true);

  assert.ok(ensureTargetCounterfactuals(deliveredAt + 1) >= 1);
  const row = listTargetCounterfactuals({ alert_id: alertId })[0];
  assert.equal(row.policy_version, "target-1_5r-v1");
  assert.equal(row.target_r, 1.5);
  assert.equal(row.target_price, 107.5);
  assert.equal(row.expires_at, deliveredAt + 48 * 60 * 60 * 1000);
  assert.ok(listOpenTargetCounterfactuals(deliveredAt + 2).some((candidate) => candidate.id === row.id));

  assert.equal(updateTargetCounterfactualOutcome(row.id, {
    outcome_status: "target",
    outcome_at: deliveredAt + 10_000,
    outcome_price: 107.5,
    pnl_r: 1.5,
    evaluated_through: deliveredAt + 10_000,
    outcome_note: "1.5R target touched before stop",
    outcome_provenance: "test",
  }), true);
  assert.equal(updateTargetCounterfactualOutcome(row.id, {
    outcome_status: "stop",
    outcome_at: deliveredAt + 20_000,
    outcome_price: 95,
    pnl_r: -1,
    evaluated_through: deliveredAt + 20_000,
    outcome_note: "late rewrite",
    outcome_provenance: "test",
  }), false);
  assert.equal(ensureTargetCounterfactuals(deliveredAt + 30_000), 0);
  assert.equal(listTargetCounterfactuals({ alert_id: alertId })[0].outcome_status, "target");

  const invalidId = insertTelegramAlert({
    created_at: now + 40_000,
    delivery_status: "delivered",
    delivered_at: now + 40_000,
    delivery_error: null,
    telegram_message_id: "target-15r-invalid",
    symbol: "TARGET15RBAD",
    sector: null,
    direction: "long",
    entry_price: 100,
    stop_price: 105,
    target_price: 115,
    size: 1,
    risk_usd: 5,
    conviction_score: 4,
    conviction_json: null,
    signal_json: null,
    family_json: null,
    expires_at: now + 40_000 + 48 * 60 * 60 * 1000,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
  });
  const invalidObservedAt = now + 50_000;
  assert.equal(ensureTargetCounterfactuals(invalidObservedAt), 1);
  const invalid = listTargetCounterfactuals({ alert_id: invalidId })[0];
  assert.equal(invalid.outcome_status, "untrackable");
  assert.equal(invalid.outcome_at, invalidObservedAt);
  assert.equal(invalid.evaluated_through, invalidObservedAt);

  const legacyId = insertTelegramAlert({
    created_at: now + 60_000,
    delivery_status: "delivered",
    delivered_at: now + 60_000,
    delivery_error: null,
    telegram_message_id: "target-15r-legacy-no-delivery-time",
    symbol: "TARGET15RLEGACY",
    sector: null,
    direction: "long",
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 1,
    risk_usd: 5,
    conviction_score: 4,
    conviction_json: null,
    signal_json: null,
    family_json: null,
    expires_at: now + 60_000 + 48 * 60 * 60 * 1000,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
  });
  getDb().prepare("update telegram_alerts set delivered_at = null where id = ?").run(legacyId);
  const legacyObservedAt = now + 70_000;
  assert.equal(ensureTargetCounterfactuals(legacyObservedAt), 1);
  const legacy = listTargetCounterfactuals({ alert_id: legacyId })[0];
  assert.equal(legacy.outcome_status, "untrackable");
  assert.equal(legacy.target_price, null);
  assert.equal(legacy.outcome_at, legacyObservedAt);
});

test("new Telegram alerts retain one exact candidate link and explicit attribution state", () => {
  const now = Date.now() + 36_000_000;
  const candidateId = insertAlertCandidate({
    evaluated_at: now,
    decision_candle_at: now - 1,
    strategy_version: "stage1-closed-bars-v2",
    symbol: "CANDIDATELINK",
    direction: "long",
    conviction_score: 4.2,
    vol_regime: "normal",
    decision: "eligible",
    decision_reason: "selected_for_telegram",
    conviction_json: "{}",
    signal_json: "[]",
    family_json: "[]",
    feature_json: "{}",
    shadow_policy_json: JSON.stringify({ policyVersion: "stage2-shadow-v1" }),
    telegram_attempted: 0,
  });
  const pending = {
    created_at: now,
    delivery_status: "pending",
    delivery_error: null,
    telegram_message_id: null,
    symbol: "CANDIDATELINK",
    sector: null,
    direction: "long",
    entry_price: 100,
    stop_price: 95,
    target_price: 115,
    size: 1,
    risk_usd: 5,
    conviction_score: 4.2,
    conviction_json: "{}",
    signal_json: "[]",
    family_json: "[]",
    expires_at: now + 48 * 60 * 60 * 1_000,
    outcome_status: "open",
    outcome_at: null,
    outcome_price: null,
    pnl_r: null,
    evaluated_through: null,
    outcome_note: null,
    outcome_provenance: null,
    candidate_id: candidateId,
    candidate_attribution: "linked",
  } as Parameters<typeof insertTelegramAlert>[0] & {
    candidate_id: number;
    candidate_attribution: "linked";
  };
  const alertId = insertTelegramAlert(pending);

  const saved = listTelegramAlerts({ symbol: "CANDIDATELINK", limit: 1 })[0] as unknown as {
    id: number;
    candidate_id: number | null;
    candidate_attribution: string;
  };
  assert.equal(saved.id, alertId);
  assert.equal(saved.candidate_id, candidateId);
  assert.equal(saved.candidate_attribution, "linked");
  assert.throws(
    () => insertTelegramAlert({ ...pending, created_at: now + 1, symbol: "CANDIDATELINKDUP" }),
    /UNIQUE constraint failed: telegram_alerts\.candidate_id/,
  );

  insertTelegramAlert({
    ...pending,
    created_at: now + 2,
    symbol: "CANDIDATEATTRFAIL",
    candidate_id: null,
    candidate_attribution: "failed",
  } as Parameters<typeof insertTelegramAlert>[0] & {
    candidate_id: null;
    candidate_attribution: "failed";
  });
  const failed = listTelegramAlerts({ symbol: "CANDIDATEATTRFAIL", limit: 1 })[0] as unknown as {
    candidate_id: number | null;
    candidate_attribution: string;
  };
  assert.equal(failed.candidate_id, null);
  assert.equal(failed.candidate_attribution, "failed");
});

test("alert candidate ledger separates generation and eligibility from delivery outcomes", () => {
  const evaluatedAt = Date.now() + 35_000_000;
  const id = insertAlertCandidate({
    evaluated_at: evaluatedAt,
    decision_candle_at: evaluatedAt - 4 * 60 * 60 * 1000,
    strategy_version: "stage1-test",
    symbol: "CANDIDATE",
    direction: "short",
    conviction_score: -4.2,
    vol_regime: "normal",
    decision: "suppressed",
    decision_reason: "active_thesis",
    conviction_json: "{}",
    signal_json: "[]",
    family_json: "[]",
    feature_json: JSON.stringify({ closedCandles: true }),
    telegram_attempted: 0,
  });
  assert.ok(id > 0);
  const rows = listAlertCandidates({ symbol: "CANDIDATE", strategy_version: "stage1-test", limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, "suppressed");
  assert.equal(rows[0].decision_reason, "active_thesis");
  assert.equal(rows[0].telegram_attempted, 0);
  assert.equal(markAlertCandidateTelegramAttempted(id), true);
  assert.equal(listAlertCandidates({ symbol: "CANDIDATE", limit: 1 })[0].telegram_attempted, 1);
});

test("alert candidate ledger retention removes only stale decision evidence", () => {
  const now = Date.now();
  const row = (symbol: string, evaluatedAt: number) => ({
    evaluated_at: evaluatedAt,
    decision_candle_at: evaluatedAt - 1,
    strategy_version: "stage1-retention",
    symbol,
    direction: "long" as const,
    conviction_score: 4,
    vol_regime: "normal" as const,
    decision: "rejected" as const,
    decision_reason: "test",
    conviction_json: "{}",
    signal_json: "[]",
    family_json: "[]",
    feature_json: "{}",
    telegram_attempted: 0 as const,
  });
  insertAlertCandidate(row("CANDIDATEOLD", now - 100 * 86_400_000));
  insertAlertCandidate(row("CANDIDATENEW", now));
  assert.ok(pruneAlertCandidates(90 * 86_400_000) >= 1);
  assert.equal(listAlertCandidates({ symbol: "CANDIDATEOLD", limit: 1 }).length, 0);
  assert.equal(listAlertCandidates({ symbol: "CANDIDATENEW", limit: 1 }).length, 1);
});

test("ambiguous Telegram acknowledgements are distinct and stale pending rows are reconciled", () => {
  const now = Date.now() + 34_000_000;
  const makePending = (symbol: string, createdAt: number) => insertTelegramAlert({
    created_at: createdAt, delivery_status: "pending", delivery_error: null,
    telegram_message_id: null, symbol, sector: null, direction: "long",
    entry_price: 100, stop_price: 95, target_price: 115, size: 1, risk_usd: 5,
    conviction_score: 4, conviction_json: null, signal_json: null, family_json: null,
    expires_at: createdAt + 48 * 60 * 60 * 1000, outcome_status: "open", outcome_at: null,
    outcome_price: null, pnl_r: null, evaluated_through: null, outcome_note: null, outcome_provenance: null,
  });

  const direct = makePending("UNKNOWNACK", now - 1_000);
  assert.equal(markTelegramAlertDeliveryUnknown(direct, "request timed out", now), true);
  const unknown = listTelegramAlerts({ symbol: "UNKNOWNACK", limit: 1 })[0];
  assert.equal(unknown.delivery_status, "failed");
  assert.equal(unknown.delivery_uncertain, 1);
  assert.equal(unknown.outcome_status, "untrackable");
  assert.match(unknown.outcome_note ?? "", /acknowledgement unknown/i);
  assert.equal(summarizeTelegramAlerts({ symbol: "UNKNOWNACK" }).unknown_delivery, 1);

  makePending("STALEACK", now - 11 * 60_000);
  makePending("FRESHACK", now - 60_000);
  assert.equal(reconcileStalePendingTelegramAlerts(now - 10 * 60_000, now), 1);
  assert.equal(listTelegramAlerts({ symbol: "STALEACK", limit: 1 })[0].delivery_uncertain, 1);
  assert.equal(listTelegramAlerts({ symbol: "FRESHACK", limit: 1 })[0].delivery_status, "pending");
});

test("telegram alert delivery failures and Telegram message IDs are durable and unique", () => {
  const id = insertTelegramAlert({
    created_at: Date.now() + 31_000_000, delivery_status: "pending", delivery_error: null,
    telegram_message_id: null, symbol: "FAILSYM", sector: null, direction: "short",
    entry_price: 10, stop_price: 11, target_price: 7, size: 10, risk_usd: 10,
    conviction_score: null, conviction_json: null, signal_json: null, family_json: null,
    expires_at: Date.now() + 48 * 60 * 60 * 1000, outcome_status: "open", outcome_at: null,
    outcome_price: null, pnl_r: null, evaluated_through: null, outcome_note: null, outcome_provenance: null,
  });
  assert.equal(markTelegramAlertFailed(id, "Telegram API: timeout", Date.now()), true);
  assert.equal(markTelegramAlertFailed(id, "another error", Date.now()), false);
  const failed = listTelegramAlerts({ symbol: "FAILSYM", limit: 1 })[0];
  assert.equal(failed.delivery_status, "failed");
  assert.equal(failed.outcome_status, "untrackable");
  assert.match(failed.outcome_note ?? "", /delivery failed/i);
  assert.throws(() => insertTelegramAlert({
    created_at: Date.now() + 32_000_000, delivery_status: "delivered", delivery_error: null,
    telegram_message_id: "tg-123", symbol: "DUPSYM", sector: null, direction: "long",
    entry_price: 1, stop_price: 0.9, target_price: 1.3, size: 1, risk_usd: 0.1,
    conviction_score: null, conviction_json: null, signal_json: null, family_json: null,
    expires_at: Date.now() + 48 * 60 * 60 * 1000, outcome_status: "open", outcome_at: null,
    outcome_price: null, pnl_r: null, evaluated_through: null, outcome_note: null, outcome_provenance: null,
  }));
});

test("telegram ledger preserves untrackable delivered alerts without a trade card", () => {
  const now = Date.now() + 33_000_000;
  const id = insertTelegramAlert({
    created_at: now, delivery_status: "delivered", delivered_at: now,
    delivery_error: null, telegram_message_id: "tg-untrackable",
    symbol: "NOCARD", sector: null, direction: "long",
    entry_price: null, stop_price: null, target_price: null, size: null, risk_usd: null,
    conviction_score: 4, conviction_json: JSON.stringify({ label: "Strong Buy" }),
    signal_json: "[]", family_json: "[]", expires_at: now + 48 * 60 * 60 * 1000,
    outcome_status: "untrackable", outcome_at: now, outcome_price: null, pnl_r: null,
    evaluated_through: now, outcome_note: "trade card unavailable", outcome_provenance: "live",
  });
  const row = listTelegramAlerts({ symbol: "NOCARD", limit: 1 })[0];
  assert.equal(row.id, id);
  assert.equal(row.entry_price, null);
  assert.equal(row.outcome_status, "untrackable");
});

test("telegram ledger rejects inconsistent delivery states at insertion", () => {
  const now = Date.now() + 35_000_000;
  const base = {
    created_at: now, delivery_error: null, symbol: "BADSTATE", sector: null,
    direction: "long" as const, entry_price: 100, stop_price: 95, target_price: 115,
    size: 1, risk_usd: 5, conviction_score: null, conviction_json: null,
    signal_json: null, family_json: null, expires_at: now + 48 * 60 * 60 * 1000,
    outcome_at: null, outcome_price: null, pnl_r: null, evaluated_through: null,
    outcome_note: null, outcome_provenance: null,
  };
  assert.throws(() => insertTelegramAlert({
    ...base,
    delivery_status: "delivered",
    delivered_at: null,
    telegram_message_id: "tg-bad-state",
    outcome_status: "open",
  }), /delivered_at/i);
  assert.throws(() => insertTelegramAlert({
    ...base,
    delivery_status: "pending",
    delivered_at: null,
    telegram_message_id: null,
    outcome_status: "untrackable",
  }), /pending/i);
});

test("open-alert reads retain expired rows long enough for resumed evaluation", () => {
  const now = Date.now() + 100_000_000;
  insertTelegramAlert({
    created_at: now - 10 * 86_400_000, delivery_status: "delivered", delivered_at: now - 10 * 86_400_000,
    delivery_error: null, telegram_message_id: "tg-resume", symbol: "RESUMESYM", sector: null,
    direction: "long", entry_price: 100, stop_price: 95, target_price: 115, size: 1, risk_usd: 5,
    conviction_score: 4, conviction_json: null, signal_json: null, family_json: null,
    expires_at: now - 8 * 86_400_000, outcome_status: "open", outcome_at: null,
    outcome_price: null, pnl_r: null, evaluated_through: null, outcome_note: null, outcome_provenance: null,
  });
  assert.ok(listOpenTelegramAlerts(now).some((row) => row.symbol === "RESUMESYM"));
});

test("telegram summary is not truncated to the default list page", () => {
  const now = Date.now() + 200_000_000;
  for (let i = 0; i < 101; i += 1) {
    insertTelegramAlert({
      created_at: now + i, delivery_status: "failed", delivered_at: null,
      delivery_error: "test", telegram_message_id: null, symbol: "SUMMARYMANY", sector: null,
      direction: "short", entry_price: 1, stop_price: 2, target_price: 0.5, size: 1, risk_usd: 1,
      conviction_score: null, conviction_json: null, signal_json: null, family_json: null,
      expires_at: now + 48 * 60 * 60 * 1000, outcome_status: "untrackable", outcome_at: now,
      outcome_price: null, pnl_r: null, evaluated_through: now, outcome_note: "failed", outcome_provenance: "test",
    });
  }
  const summary = summarizeTelegramAlerts({ symbol: "SUMMARYMANY" });
  assert.equal(summary.total, 101);
  assert.equal(summary.failed, 101);
});

test("bounded snapshot and candle range reads return oldest-first evidence", () => {
  const base = 1_850_000_000_000;
  insertPriceSnapshots([
    { symbol: "RANGE", ts: base, mark: 10, prev_day: null, funding: null, oi: null, volume: null },
    { symbol: "RANGE", ts: base + 60_000, mark: 11, prev_day: null, funding: null, oi: null, volume: null },
    { symbol: "RANGE", ts: base + 120_000, mark: 12, prev_day: null, funding: null, oi: null, volume: null },
  ]);
  upsertCandles([
    { symbol: "RANGE", interval: "1h", t: base, o: 10, h: 12, l: 9, c: 11, v: 1 },
    { symbol: "RANGE", interval: "1h", t: base + 3_600_000, o: 11, h: 13, l: 10, c: 12, v: 1 },
  ]);

  assert.deepEqual(priceSnapshotsInRange("RANGE", base + 1, base + 120_000, 10), [
    { ts: base + 60_000, mark: 11 },
    { ts: base + 120_000, mark: 12 },
  ]);
  assert.deepEqual(candlesInRange("RANGE", "1h", base, base + 3_600_000, 10).map((row) => row.t), [
    base,
    base + 3_600_000,
  ]);
});

test("market-open OI report reservation is atomic and idempotent by session key", () => {
  const generatedAt = Date.now() + 300_000_000;
  const report = {
    report_key: "asia:2099-01-05",
    region: "asia" as const,
    local_date: "2099-01-05",
    report_at: generatedAt,
    open_at: generatedAt + 30 * 60_000,
    generated_at: generatedAt,
    lookback_ms: 4 * 60 * 60_000,
    calendar_covered: 0 as const,
    selection_config_json: JSON.stringify({ version: 1 }),
    message_body: "test OI report",
  };
  const item = (rank: number, symbol: string, universe: "crypto" | "equity") => ({
    rank,
    symbol,
    sector: universe === "crypto" ? "majors" : "stocks",
    universe,
    current_ts: generatedAt,
    prior_ts: generatedAt - 4 * 60 * 60_000,
    current_mark: 110,
    prior_mark: 100,
    current_oi_coins: 120,
    prior_oi_coins: 100,
    current_oi_usd: 13_200,
    prior_oi_usd: 10_000,
    oi_quantity_delta_usd: 2_000,
    oi_usd_delta: 3_200,
    oi_coins_change_pct: 20,
    price_change_pct: 10,
    funding_hourly: 0.0001,
    funding_apr: 87.6,
    volume_24h: 1_000_000,
    quadrant: "expanding_up" as const,
    smart_flow_delta_usd: null,
    smart_flow_alignment: "unknown" as const,
  });

  const first = reserveMarketOpenOiReport(report, [
    item(1, "BTC", "crypto"),
    item(1, "SMSN", "equity"),
  ]);
  const duplicate = reserveMarketOpenOiReport(report, [
    item(1, "BTC", "crypto"),
    item(1, "SMSN", "equity"),
  ]);

  assert.equal(first.kind, "inserted");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.id, first.id);
  assert.equal(listMarketOpenOiReports({ key: report.report_key }).length, 1);
  assert.deepEqual(listMarketOpenOiItems(first.id).map((row) => row.symbol).sort(), ["BTC", "SMSN"]);
  assert.equal(listPendingMarketOpenOiReports(10).find((row) => row.id === first.id)?.message_body, "test OI report");
});

function reserveOiReportForDbTest(suffix: string): { kind: "inserted"; id: number } {
  const generatedAt = Date.now() + 400_000_000 + Number(suffix) * 100_000;
  const result = reserveMarketOpenOiReport({
      report_key: `us:2099-02-${suffix}`,
      region: "us",
      local_date: `2099-02-${suffix}`,
      report_at: generatedAt,
      open_at: generatedAt + 30 * 60_000,
      generated_at: generatedAt,
      lookback_ms: 4 * 60 * 60_000,
      calendar_covered: 0,
      selection_config_json: "{}",
      message_body: "test OI report",
    }, ["BTC", "ETH"].map((symbol, index) => ({
      rank: index + 1, symbol, sector: "majors", universe: "crypto" as const,
      current_ts: generatedAt, prior_ts: generatedAt - 4 * 60 * 60_000,
      current_mark: 110, prior_mark: 100, current_oi_coins: 120, prior_oi_coins: 100,
      current_oi_usd: 13_200, prior_oi_usd: 10_000, oi_quantity_delta_usd: 2_000,
      oi_usd_delta: 3_200, oi_coins_change_pct: 20, price_change_pct: 10,
      funding_hourly: 0, funding_apr: 0, volume_24h: 1_000_000,
      quadrant: "expanding_up" as const, smart_flow_delta_usd: null,
      smart_flow_alignment: "unknown" as const,
    })));
  if (result.kind !== "inserted") throw new Error(`Duplicate market-open test report: ${suffix}`);
  return result;
}

test("market-open OI delivery keeps attempted, delivered, rejected, and unknown facts distinct", () => {
  const delivered = reserveOiReportForDbTest("11");
  const failed = reserveOiReportForDbTest("12");
  const unknown = reserveOiReportForDbTest("13");
  const stale = reserveOiReportForDbTest("14");
  assert.equal(delivered.kind, "inserted");
  assert.equal(failed.kind, "inserted");
  assert.equal(unknown.kind, "inserted");
  assert.equal(stale.kind, "inserted");

  assert.equal(markMarketOpenOiDelivered(delivered.id, "oi-msg-1", 10), false);
  assert.equal(markMarketOpenOiDeliveryAttempted(delivered.id, 9), true);
  assert.equal(markMarketOpenOiDelivered(delivered.id, "oi-msg-1", 10), true);
  assert.equal(markMarketOpenOiDelivered(delivered.id, "oi-msg-1", 11), false);
  assert.equal(markMarketOpenOiDeliveryAttempted(failed.id, 20), true);
  assert.equal(markMarketOpenOiFailed(failed.id, "rejected", 21), true);
  assert.equal(markMarketOpenOiDeliveryAttempted(unknown.id, 30), true);
  assert.equal(markMarketOpenOiUnknown(unknown.id, "timeout", 31), true);
  assert.equal(markMarketOpenOiDeliveryAttempted(stale.id, 40), true);
  assert.equal(reconcileStaleAttemptedMarketOpenOiReports(41, 42), 1);

  assert.deepEqual(summarizeMarketOpenOiReports(), {
    total: 5,
    shadow: 0,
    pending: 1,
    delivered: 1,
    failed: 1,
    unknown: 2,
    expired: 0,
  });
});

test("stale unattempted market-open OI reports expire without fabricating an attempt", () => {
  const stale = reserveOiReportForDbTest("15");
  assert.equal(markMarketOpenOiExpired(stale.id, "send window elapsed", 50), true);
  assert.equal(markMarketOpenOiDeliveryAttempted(stale.id, 51), false);
  const row = listMarketOpenOiReports({ key: "us:2099-02-15" })[0];
  assert.equal(row.delivery_status, "expired");
  assert.equal(row.delivery_attempted_at, null);
  assert.equal(row.delivery_error, "send window elapsed");
  assert.equal(summarizeMarketOpenOiReports().expired, 1);
});

test("shadow market-open OI reports persist evidence without entering the delivery queue", () => {
  const generatedAt = Date.now() + 500_000_000;
  const base = listMarketOpenOiItems(listMarketOpenOiReports({ key: "asia:2099-01-05" })[0].id)[0];
  const item = (rank: number, symbol: string) => {
    const { id, report_id: reportId, ...evidence } = base;
    void id;
    void reportId;
    return { ...evidence, rank, symbol };
  };
  const reservation = reserveMarketOpenOiReport({
    report_key: "europe:2099-03-01", region: "europe", local_date: "2099-03-01",
    report_at: generatedAt, open_at: generatedAt + 30 * 60_000, generated_at: generatedAt,
    lookback_ms: 4 * 60 * 60_000, calendar_covered: 0, selection_config_json: "{}",
    message_body: "shadow report",
  }, [item(1, "SHADOW1"), item(2, "SHADOW2")], "shadow");
  assert.equal(reservation.kind, "inserted");
  const row = listMarketOpenOiReports({ key: "europe:2099-03-01" })[0];
  assert.equal(row.delivery_status, "shadow");
  assert.equal(markMarketOpenOiDeliveryAttempted(row.id, generatedAt + 1), false);
  assert.equal(listPendingMarketOpenOiReports(100).some((pending) => pending.id === row.id), false);
  assert.ok(summarizeMarketOpenOiReports().shadow >= 1);
});

test("market-open OI evidence accepts a complete unwind to zero current OI", () => {
  const generatedAt = Date.now() + 600_000_000;
  const base = listMarketOpenOiItems(listMarketOpenOiReports({ key: "asia:2099-01-05" })[0].id)[0];
  const { id, report_id: reportId, ...evidence } = base;
  void id;
  void reportId;
  const reservation = reserveMarketOpenOiReport({
    report_key: "us:2099-03-02", region: "us", local_date: "2099-03-02",
    report_at: generatedAt, open_at: generatedAt + 30 * 60_000, generated_at: generatedAt,
    lookback_ms: 4 * 60 * 60_000, calendar_covered: 0, selection_config_json: "{}",
    message_body: "complete unwind",
  }, [{
    ...evidence,
    symbol: "UNWIND",
    current_oi_coins: 0,
    current_oi_usd: 0,
    oi_quantity_delta_usd: -evidence.prior_oi_usd,
    oi_usd_delta: -evidence.prior_oi_usd,
    oi_coins_change_pct: -100,
  }], "shadow");
  assert.equal(reservation.kind, "inserted");
});

test("market-open OI outcome observations are append-once per item and horizon", () => {
  const report = listMarketOpenOiReports({ key: "asia:2099-01-05" })[0];
  const item = listMarketOpenOiItems(report.id)[0];
  assert.equal(upsertMarketOpenOiOutcome({
    item_id: item.id,
    horizon: "open",
    target_at: report.open_at,
    status: "observed",
    snapshot_at: report.open_at - 1_000,
    mark: 111,
    return_pct: null,
    observed_at: report.open_at + 1_000,
    note: null,
  }), true);
  assert.equal(upsertMarketOpenOiOutcome({
    item_id: item.id,
    horizon: "open",
    target_at: report.open_at,
    status: "observed",
    snapshot_at: report.open_at,
    mark: 999,
    return_pct: null,
    observed_at: report.open_at + 2_000,
    note: "late overwrite",
  }), false);
  assert.equal(listMarketOpenOiOutcomes(item.id)[0].mark, 111);
  assert.deepEqual(
    listPendingMarketOpenOiOutcomeItems(report.open_at + 11 * 60_000, 10).map((row) => row.symbol),
    ["SMSN"],
  );
  assert.deepEqual(
    listPendingMarketOpenOiOutcomeItems(report.open_at + 60 * 60_000 + 11 * 60_000, 10)
      .map((row) => row.symbol).sort(),
    ["BTC", "SMSN"],
  );
});

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
  prunePriceSnapshots,
  upsertCandles,
  getCandlesFromCache,
  loadEventHistory,
  recordEventFire,
  eventHistoryKey,
  kvGet,
  kvSet,
  insertSocialSnapshots,
  latestSocialSnapshots,
  pruneSocialSnapshots,
  insertTrade,
  closeTrade,
  listTrades,
  getTrade,
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

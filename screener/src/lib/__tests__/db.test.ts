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
  prunePriceSnapshots,
  upsertCandles,
  getCandlesFromCache,
  loadEventHistory,
  recordEventFire,
  kvGet,
  kvSet,
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

test("snapshotAt returns the row at or before the target timestamp", () => {
  const base = Date.now() + 1_000_000; // shift so we don't collide with prior test
  insertPriceSnapshots([
    { symbol: "SOL", ts: base + 0,       mark: 100, prev_day: 99, funding: 0, oi: 1, volume: 1 },
    { symbol: "SOL", ts: base + 60_000,  mark: 105, prev_day: 99, funding: 0, oi: 1, volume: 1 },
    { symbol: "SOL", ts: base + 120_000, mark: 110, prev_day: 99, funding: 0, oi: 1, volume: 1 },
  ]);
  // Target halfway between t1 and t2 — should return t1's mark.
  const m = snapshotAt(base + 90_000, ["SOL"]);
  assert.equal(m.get("SOL"), 105);
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
  recordEventFire("EVTSYM", "rsi_overbought", 1_234_567_890);
  recordEventFire("EVTSYM", "rsi_overbought", 1_234_567_999); // overwrite
  const h = loadEventHistory();
  assert.equal(h.get("EVTSYM:rsi_overbought"), 1_234_567_999, "latest fire should win");
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

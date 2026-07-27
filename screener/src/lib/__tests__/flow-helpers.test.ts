// Flow-metric DAL helpers: snapshotFullAtBounded + avgFundingSince.
// These back the OI-delta / mean-funding columns in /api/markets.
//
// IMPORTANT: db-test-setup must be the first import — it sets
// SCREENER_DB_PATH before the db module reads it at load time.
import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  insertPriceSnapshots,
  snapshotFullAtBounded,
  avgFundingSince,
  snapshotAt,
  snapshotAtBounded,
} from "../db";

// Reference implementation: the exact shape snapshotAtBounded had before
// it was rewritten as a bounded index seek for performance (7.3s -> 4.5ms).
// The rewrite must be a pure optimisation, so the two must agree on every
// input — including the edges where a row sits exactly on the tolerance
// boundary, and where the nearest row is on the wrong side of the target.
function snapshotAtBoundedReference(
  targetTs: number,
  maxAgeMs: number,
  symbols: string[],
): Map<string, number> {
  const rows = snapshotAt(targetTs, symbols);
  const out = new Map<string, number>();
  for (const [sym, row] of rows) {
    if (Math.abs(targetTs - row.ts) <= maxAgeMs) out.set(sym, row.mark);
  }
  return out;
}

// Symbols are unique per test — the tmp DB is shared across cases in the
// process, so distinct symbols keep the tests independent.

test("snapshotFullAtBounded returns mark, oi and funding from the SAME row", () => {
  const base = Date.now();
  insertPriceSnapshots([
    { symbol: "FULLA", ts: base - 120_000, mark: 100, prev_day: 99, funding: 0.0001, oi: 10, volume: 1 },
    { symbol: "FULLA", ts: base - 60_000,  mark: 105, prev_day: 99, funding: 0.0002, oi: 20, volume: 1 },
    { symbol: "FULLA", ts: base,           mark: 110, prev_day: 99, funding: 0.0003, oi: 30, volume: 1 },
  ]);
  // Target sits between the -60s and now rows → the -60s row wins.
  const m = snapshotFullAtBounded(base - 30_000, 60_000, ["FULLA"]);
  const row = m.get("FULLA");
  assert.equal(row?.mark, 105);
  assert.equal(row?.oi, 20, "oi must come from the same row as the mark");
  assert.equal(row?.funding, 0.0002, "funding must come from the same row as the mark");
  assert.equal(row?.volume, 1, "volume must come from the same row as mark/OI/funding");
  assert.equal(row?.ts, base - 60_000);
});

test("snapshotFullAtBounded drops rows outside the tolerance window", () => {
  const base = Date.now() + 10_000_000;
  insertPriceSnapshots([
    { symbol: "FULLB", ts: base, mark: 50, prev_day: 49, funding: 0.0001, oi: 5, volume: 1 },
  ]);
  // Nearest row is 10min before target; tolerance is 1min → rejected.
  const tight = snapshotFullAtBounded(base + 600_000, 60_000, ["FULLB"]);
  assert.equal(tight.get("FULLB"), undefined, "stale row must be dropped, not returned");
  // Same lookup with a generous tolerance → accepted.
  const loose = snapshotFullAtBounded(base + 600_000, 3_600_000, ["FULLB"]);
  assert.equal(loose.get("FULLB")?.mark, 50);
});

test("snapshotFullAtBounded tolerates null oi/funding", () => {
  const base = Date.now() + 20_000_000;
  insertPriceSnapshots([
    { symbol: "FULLC", ts: base, mark: 7, prev_day: null, funding: null, oi: null, volume: null },
  ]);
  const row = snapshotFullAtBounded(base, 60_000, ["FULLC"]).get("FULLC");
  assert.equal(row?.mark, 7);
  assert.equal(row?.oi, null);
  assert.equal(row?.funding, null);
});

test("avgFundingSince averages only rows at or after sinceTs", () => {
  const base = Date.now() + 30_000_000;
  insertPriceSnapshots([
    // Before the window — must be excluded (would drag the mean to 0.01).
    { symbol: "AVGA", ts: base - 60_000, mark: 1, prev_day: 1, funding: 0.01, volume: 1, oi: 1 },
    { symbol: "AVGA", ts: base,          mark: 1, prev_day: 1, funding: 0.0002, volume: 1, oi: 1 },
    { symbol: "AVGA", ts: base + 60_000, mark: 1, prev_day: 1, funding: 0.0004, volume: 1, oi: 1 },
  ]);
  const m = avgFundingSince(base, ["AVGA"]);
  assert.ok(Math.abs((m.get("AVGA") ?? 0) - 0.0003) < 1e-9, "mean of the two in-window rows");
});

test("avgFundingSince ignores null funding rather than counting it as zero", () => {
  const base = Date.now() + 40_000_000;
  insertPriceSnapshots([
    { symbol: "AVGB", ts: base,          mark: 1, prev_day: 1, funding: 0.001, oi: 1, volume: 1 },
    { symbol: "AVGB", ts: base + 60_000, mark: 1, prev_day: 1, funding: null,  oi: 1, volume: 1 },
  ]);
  const m = avgFundingSince(base, ["AVGB"]);
  assert.ok(Math.abs((m.get("AVGB") ?? 0) - 0.001) < 1e-9, "null row must not pull the mean toward 0");
});

test("avgFundingSince respects the symbols filter and omits symbols with no data", () => {
  const base = Date.now() + 50_000_000;
  insertPriceSnapshots([
    { symbol: "AVGC", ts: base, mark: 1, prev_day: 1, funding: 0.001, oi: 1, volume: 1 },
    { symbol: "AVGD", ts: base, mark: 1, prev_day: 1, funding: 0.002, oi: 1, volume: 1 },
  ]);
  const m = avgFundingSince(base, ["AVGC"]);
  assert.ok(m.has("AVGC"));
  assert.equal(m.has("AVGD"), false, "unrequested symbol must not appear");
  // A symbol with only out-of-window rows is absent (not zero) — callers
  // distinguish "no data" from "flat funding".
  const empty = avgFundingSince(base + 999_999_999, ["AVGC"]);
  assert.equal(empty.has("AVGC"), false);
});

test("snapshotAtBounded (bounded seek) matches the pre-optimisation reference exactly", () => {
  const base = Date.now() + 70_000_000;
  // A deliberately awkward series: irregular gaps, a symbol whose only row
  // is far in the past, and a symbol with rows on both sides of the target.
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({
      symbol: "EQA", ts: base + i * 37_000, mark: 100 + i,
      prev_day: 99, funding: 0.0001 * i, oi: 10 + i, volume: 1,
    });
  }
  rows.push({ symbol: "EQB", ts: base - 30 * 86_400_000, mark: 5, prev_day: 5, funding: 0, oi: 1, volume: 1 });
  rows.push({ symbol: "EQC", ts: base + 500_000, mark: 42, prev_day: 42, funding: 0, oi: 1, volume: 1 });
  insertPriceSnapshots(rows);

  const syms = ["EQA", "EQB", "EQC", "EQ_MISSING"];
  // Sweep targets across the whole series and tolerances across the gap
  // size, including exact-boundary values (37_000 == one full gap).
  for (const tol of [0, 1, 36_999, 37_000, 37_001, 120_000, 6 * 3_600_000]) {
    for (let step = -2; step <= 42; step += 3) {
      const target = base + step * 37_000;
      const got = snapshotAtBounded(target, tol, syms);
      const want = snapshotAtBoundedReference(target, tol, syms);
      assert.deepEqual(
        [...got.entries()].sort(),
        [...want.entries()].sort(),
        `mismatch at target=base+${step}*37000, tol=${tol}`,
      );
    }
  }
});

test("snapshotFullAtBounded agrees with snapshotAtBounded on which row wins", () => {
  // The two helpers must pick the SAME row — the flow metrics pair
  // snapshotFullAtBounded's oi with change% derived from marks, so a
  // divergence here would silently compare different points in time.
  const base = Date.now() + 80_000_000;
  const rows = [];
  for (let i = 0; i < 25; i++) {
    rows.push({
      symbol: "AGREE", ts: base + i * 61_000, mark: 200 + i * 3,
      prev_day: 1, funding: 0.00005, oi: 1000 + i, volume: 1,
    });
  }
  insertPriceSnapshots(rows);
  for (const tol of [0, 61_000, 300_000]) {
    for (let step = 0; step <= 24; step += 2) {
      const target = base + step * 61_000 + 5_000;
      const mark = snapshotAtBounded(target, tol, ["AGREE"]).get("AGREE");
      const full = snapshotFullAtBounded(target, tol, ["AGREE"]).get("AGREE");
      assert.equal(full?.mark, mark, `row choice diverged at step=${step}, tol=${tol}`);
    }
  }
});

test("avgFundingSince handles negative funding (shorts paying) without sign loss", () => {
  const base = Date.now() + 60_000_000;
  insertPriceSnapshots([
    { symbol: "AVGE", ts: base,          mark: 1, prev_day: 1, funding: -0.002, oi: 1, volume: 1 },
    { symbol: "AVGE", ts: base + 60_000, mark: 1, prev_day: 1, funding: -0.004, oi: 1, volume: 1 },
  ]);
  const m = avgFundingSince(base, ["AVGE"]);
  assert.ok(Math.abs((m.get("AVGE") ?? 0) - -0.003) < 1e-9);
});

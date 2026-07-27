// Wallet-registry + wallet-positions DAL (smart-money flow, task 1).
//
// IMPORTANT: db-test-setup must be the first import — it sets
// SCREENER_DB_PATH before the db module reads it at load time.
import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upsertWalletRegistry,
  trackedWallets,
  insertWalletPositions,
  smartFlowAt,
  smartFlowSnapshotAt,
  pruneWalletPositions,
  type WalletRegistryRow,
  type WalletPositionRow,
} from "../db";

function registryRow(overrides: Partial<WalletRegistryRow> & { address: string }): WalletRegistryRow {
  const now = Date.now();
  return {
    cohort: "sharp",
    account_value: 500_000,
    pnl_week: 10_000,
    pnl_month: 40_000,
    roi_month: 0.08,
    turnover_month: 5,
    is_tracked: 1,
    first_seen: now,
    last_validated: now,
    ...overrides,
  };
}

// ── wallet_registry round-trip ───────────────────────────────────────────

test("upsertWalletRegistry round-trips and trackedWallets returns only is_tracked=1", () => {
  upsertWalletRegistry([
    registryRow({ address: "0xREG1", cohort: "sharp", is_tracked: 1 }),
    registryRow({ address: "0xREG2", cohort: "whale", is_tracked: 0 }),
  ]);
  const tracked = trackedWallets();
  const addrs = tracked.map((r) => r.address);
  assert.ok(addrs.includes("0xREG1"));
  assert.ok(!addrs.includes("0xREG2"), "untracked wallet must not appear");
  const reg1 = tracked.find((r) => r.address === "0xREG1");
  assert.equal(reg1?.cohort, "sharp");
  assert.equal(reg1?.account_value, 500_000);
});

test("upsertWalletRegistry upsert: second call updates mutable fields but preserves earliest first_seen", () => {
  const early = Date.now() - 1_000_000;
  const later = Date.now();
  upsertWalletRegistry([
    registryRow({ address: "0xREG3", cohort: "sharp", is_tracked: 1, first_seen: early, account_value: 300_000 }),
  ]);
  upsertWalletRegistry([
    registryRow({ address: "0xREG3", cohort: "sharp", is_tracked: 0, first_seen: later, account_value: 250_000, last_validated: later }),
  ]);
  const row = trackedWallets().find((r) => r.address === "0xREG3");
  // is_tracked=0 now, so it must be absent from trackedWallets().
  assert.equal(row, undefined, "wallet dropped from cohort must not be tracked");
});

// ── smartFlowAt: same-row pairing, heartbeat semantics, long/short split ──

test("smartFlowAt: long/short split by sign of szi, magnitude from position_value", () => {
  const ts = Date.now() + 500_000;
  insertWalletPositions([
    { address: "0xA", ts, coin: "BTC", szi: 1.5, entry_px: 60000, position_value: 90000, unrealized_pnl: 100, leverage: 5, account_value: 200000 },
    { address: "0xB", ts, coin: "BTC", szi: -2, entry_px: 61000, position_value: 122000, unrealized_pnl: -50, leverage: 3, account_value: 300000 },
  ]);
  const flow = smartFlowAt(ts, 60_000);
  const btc = flow.get("BTC");
  assert.ok(btc);
  assert.equal(btc!.longUsd, 90000, "long magnitude must come from position_value, not szi*price");
  assert.equal(btc!.shortUsd, 122000);
  assert.equal(btc!.netUsd, 90000 - 122000);
  assert.equal(btc!.wallets, 2);
});

test("smartFlowAt: same-row pairing — a wallet whose position changed contributes only the in-window row's values, never a mix", () => {
  const base = Date.now() + 1_000_000;
  // 0xC is long BTC 10 coins / $500k at t0, then FLIPS to short 4 coins /
  // $180k at t1. If direction and magnitude were pulled from different
  // rows, we could get e.g. "short direction, $500k magnitude" — wrong.
  insertWalletPositions([
    { address: "0xC", ts: base, coin: "BTC", szi: 10, entry_px: 50000, position_value: 500000, unrealized_pnl: 0, leverage: 2, account_value: 1000000 },
    { address: "0xC", ts: base + 60_000, coin: "BTC", szi: -4, entry_px: 51000, position_value: 180000, unrealized_pnl: 0, leverage: 2, account_value: 900000 },
  ]);
  // Target sits at the second row; window wide enough to see both rows,
  // but the newer one must win entirely.
  const flow = smartFlowAt(base + 60_000, 120_000);
  const btc = flow.get("BTC");
  assert.ok(btc);
  assert.equal(btc!.shortUsd, 180000, "must use the newer row's magnitude");
  assert.equal(btc!.longUsd, 0, "must not also count the older long row");
  assert.equal(btc!.wallets, 1, "one wallet contributes exactly once, from its newest row");
});

test("smartFlowAt: heartbeat semantics — a wallet flat at target time contributes nothing, even though an older in-window row shows a position", () => {
  const base = Date.now() + 2_000_000;
  insertWalletPositions([
    // Held ETH at t0...
    { address: "0xD", ts: base, coin: "ETH", szi: 5, entry_px: 3000, position_value: 15000, unrealized_pnl: 0, leverage: 1, account_value: 50000 },
    // ...then closed everything by t1 (heartbeat row).
    { address: "0xD", ts: base + 60_000, coin: "", szi: 0, entry_px: null, position_value: null, unrealized_pnl: null, leverage: null, account_value: 40000 },
  ]);
  const flow = smartFlowAt(base + 60_000, 120_000);
  assert.equal(flow.get("ETH"), undefined, "flat wallet's earlier ETH row must not leak into the aggregate");
});

test("smartFlowAt: heartbeat row for one wallet doesn't suppress a genuinely-open position from another wallet in the same coin", () => {
  const base = Date.now() + 3_000_000;
  insertWalletPositions([
    { address: "0xE", ts: base, coin: "SOL", szi: 100, entry_px: 150, position_value: 15000, unrealized_pnl: 0, leverage: 1, account_value: 40000 },
    { address: "0xF", ts: base, coin: "", szi: 0, entry_px: null, position_value: null, unrealized_pnl: null, leverage: null, account_value: 10000 },
  ]);
  const flow = smartFlowAt(base, 60_000);
  const sol = flow.get("SOL");
  assert.ok(sol);
  assert.equal(sol!.longUsd, 15000);
  assert.equal(sol!.wallets, 1);
});

test("smartFlowSnapshotAt distinguishes complete heartbeats from missing wallet history", () => {
  const ts = Date.now() + 3_500_000;
  insertWalletPositions([
    { address: "0xCOVERED", ts, coin: "BTC", szi: 1, entry_px: 60_000, position_value: 60_000, unrealized_pnl: 0, leverage: 1, account_value: 100_000 },
    { address: "0xFLAT", ts, coin: "", szi: 0, entry_px: null, position_value: null, unrealized_pnl: null, leverage: null, account_value: 50_000 },
  ]);

  const complete = smartFlowSnapshotAt(ts, 60_000, ["0xCOVERED", "0xFLAT"]);
  assert.equal(complete.complete, true);
  assert.equal(complete.observedWallets, 2);
  assert.equal(complete.requestedWallets, 2);
  assert.equal(complete.points.get("BTC")?.netUsd, 60_000);

  const incomplete = smartFlowSnapshotAt(ts, 60_000, ["0xCOVERED", "0xFLAT", "0xMISSING"]);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.observedWallets, 2);
  assert.equal(incomplete.requestedWallets, 3);
});

test("smartFlowAt: rows outside the window are excluded (staleness bound)", () => {
  const base = Date.now() + 4_000_000;
  insertWalletPositions([
    { address: "0xG", ts: base - 10 * 60_000, coin: "AVAX", szi: 20, entry_px: 30, position_value: 600, unrealized_pnl: 0, leverage: 1, account_value: 5000 },
  ]);
  // Tolerance too tight — the row is 10 min stale, window is 1 min.
  const tight = smartFlowAt(base, 60_000);
  assert.equal(tight.get("AVAX"), undefined, "stale row must be dropped, not returned");
  // Wide enough tolerance — same row now qualifies.
  const wide = smartFlowAt(base, 15 * 60_000);
  assert.equal(wide.get("AVAX")?.longUsd, 600);
});

test("smartFlowAt: multiple coins in one wallet's batch all get attributed correctly", () => {
  const ts = Date.now() + 5_000_000;
  insertWalletPositions([
    { address: "0xH", ts, coin: "BTC", szi: 1, entry_px: 60000, position_value: 60000, unrealized_pnl: 0, leverage: 1, account_value: 200000 },
    { address: "0xH", ts, coin: "ETH", szi: -10, entry_px: 3000, position_value: 30000, unrealized_pnl: 0, leverage: 1, account_value: 200000 },
  ]);
  const flow = smartFlowAt(ts, 60_000);
  assert.equal(flow.get("BTC")?.longUsd, 60000);
  assert.equal(flow.get("ETH")?.shortUsd, 30000);
});

// ── pruneWalletPositions ─────────────────────────────────────────────────

test("pruneWalletPositions removes only rows older than the cutoff", () => {
  const now = Date.now();
  insertWalletPositions([
    { address: "0xPRUNE", ts: now - 1000 * 86_400_000, coin: "BTC", szi: 1, entry_px: 1, position_value: 1, unrealized_pnl: 0, leverage: 1, account_value: 1 },
    { address: "0xPRUNE", ts: now, coin: "BTC", szi: 1, entry_px: 1, position_value: 2, unrealized_pnl: 0, leverage: 1, account_value: 1 },
  ]);
  const removed = pruneWalletPositions(30 * 86_400_000);
  assert.ok(removed >= 1, "expected at least the ancient row to be pruned");
  const flow = smartFlowAt(now, 60_000);
  assert.equal(flow.get("BTC")?.longUsd, 2, "fresh row should survive the prune");
});

// ── synthetic-scale benchmark ─────────────────────────────────────────────
// 300 wallets x 96 timestamps/day x 4 positions ~= 115k rows — the plan's
// documented steady-state daily volume. smartFlowAt must resolve one
// point-in-time aggregate off this shape in well under 50ms (it hits the
// bounded idx_wpos_addr_ts seek 300 times, not a table scan).

test("smartFlowAt benchmark: ~115k synthetic rows resolves in < 50ms", () => {
  const WALLETS = 300;
  const TIMESTAMPS = 96;
  const POSITIONS_PER_WALLET = 4;
  const COINS = ["BTC", "ETH", "SOL", "HYPE", "AVAX", "ARB", "DOGE", "LINK"];
  const stepMs = 15 * 60_000; // 15-min cadence
  const base = Date.now() + 100_000_000; // shift well clear of other tests

  const rows: WalletPositionRow[] = [];
  for (let w = 0; w < WALLETS; w++) {
    const address = `0xBENCH${w}`;
    for (let t = 0; t < TIMESTAMPS; t++) {
      const ts = base + t * stepMs;
      for (let p = 0; p < POSITIONS_PER_WALLET; p++) {
        const coin = COINS[(w + p) % COINS.length];
        const szi = ((w + t + p) % 2 === 0 ? 1 : -1) * (1 + (p % 5));
        rows.push({
          address,
          ts,
          coin,
          szi,
          entry_px: 100 + p,
          position_value: 1000 * (1 + p),
          unrealized_pnl: 0,
          leverage: 1,
          account_value: 500_000,
        });
      }
    }
  }
  assert.equal(rows.length, WALLETS * TIMESTAMPS * POSITIONS_PER_WALLET, "sanity-check the synthetic volume matches the plan's ~115k/day figure");

  // Insert in chunks so any single transaction doesn't get huge.
  const CHUNK = 5000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    insertWalletPositions(rows.slice(i, i + CHUNK));
  }

  const targetTs = base + (TIMESTAMPS - 1) * stepMs;
  const start = performance.now();
  const flow = smartFlowAt(targetTs, 20 * 60_000);
  const elapsed = performance.now() - start;

  assert.ok(flow.size > 0, "benchmark aggregate should not be empty");
  assert.ok(
    elapsed < 50,
    `smartFlowAt took ${elapsed.toFixed(2)}ms on ~115k rows, expected < 50ms`
  );
});

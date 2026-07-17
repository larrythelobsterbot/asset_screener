// Pure derivation tests for computeSmartFlowRows — no DB involved, so the
// null-vs-zero delta semantics and the divergence gate are exercised
// directly against hand-built SmartFlowPoint maps. See smart-flow.test.ts
// for the DAL-level smartFlowAt tests this builds on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSmartFlowRows, type SmartFlowCoin } from "../smartFlow";
import type { SmartFlowPoint } from "../db";

function point(overrides: Partial<SmartFlowPoint>): SmartFlowPoint {
  return { longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0, ...overrides };
}

function findCoin(rows: SmartFlowCoin[], coin: string): SmartFlowCoin | undefined {
  return rows.find((r) => r.coin === coin);
}

test("empty historical map yields null deltas, not zero", () => {
  const nowMap = new Map([
    ["BTC", point({ longUsd: 100_000, shortUsd: 20_000, netUsd: 80_000, wallets: 3 })],
  ]);
  const empty1h = new Map<string, SmartFlowPoint>();
  const empty24h = new Map<string, SmartFlowPoint>();
  const crowd = new Map<string, number | null>();

  const rows = computeSmartFlowRows(nowMap, empty1h, empty24h, crowd);
  const btc = findCoin(rows, "BTC");
  assert.ok(btc);
  assert.equal(btc?.netDelta1h, null, "poller too young at -1h → null, not 0");
  assert.equal(btc?.netDelta24h, null, "poller too young at -24h → null, not 0");
});

test("non-empty historical map missing this coin treats the prior value as a real 0", () => {
  const nowMap = new Map([
    ["ETH", point({ longUsd: 60_000, shortUsd: 0, netUsd: 60_000, wallets: 2 })],
  ]);
  // The cohort had data at -1h, just not in ETH — a genuine "no position then".
  const map1h = new Map([
    ["SOL", point({ longUsd: 10_000, shortUsd: 0, netUsd: 10_000, wallets: 1 })],
  ]);
  const map24h = new Map<string, SmartFlowPoint>(); // still cold at -24h
  const crowd = new Map<string, number | null>();

  const rows = computeSmartFlowRows(nowMap, map1h, map24h, crowd);
  const eth = findCoin(rows, "ETH");
  assert.equal(eth?.netDelta1h, 60_000, "prior net was a real 0 → delta is now - 0");
  assert.equal(eth?.netDelta24h, null, "still no data at -24h → null");
});

test("gross exposure at or below $50k is excluded from the response", () => {
  const nowMap = new Map([
    ["SMALL", point({ longUsd: 30_000, shortUsd: 20_000, netUsd: 10_000, wallets: 1 })], // gross = 50k exactly
    ["BIG", point({ longUsd: 30_000, shortUsd: 21_000, netUsd: 9_000, wallets: 1 })], // gross = 51k
  ]);
  const empty = new Map<string, SmartFlowPoint>();
  const crowd = new Map<string, number | null>();

  const rows = computeSmartFlowRows(nowMap, empty, empty, crowd);
  assert.equal(findCoin(rows, "SMALL"), undefined, "gross exactly at the $50k floor must be excluded");
  assert.ok(findCoin(rows, "BIG"), "gross above the $50k floor must be included");
});

test("coin='' heartbeat entries are never emitted even if present in the map", () => {
  const nowMap = new Map([
    ["", point({ longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 5 })],
    ["BTC", point({ longUsd: 100_000, shortUsd: 0, netUsd: 100_000, wallets: 1 })],
  ]);
  const empty = new Map<string, SmartFlowPoint>();
  const rows = computeSmartFlowRows(nowMap, empty, empty, new Map());
  assert.equal(findCoin(rows, ""), undefined);
  assert.ok(findCoin(rows, "BTC"));
});

test("diverging: true when signs disagree and |netDelta24h| exceeds $250k", () => {
  const nowMap = new Map([
    ["BTC", point({ longUsd: 400_000, shortUsd: 0, netUsd: 400_000, wallets: 4 })],
  ]);
  const map1h = new Map<string, SmartFlowPoint>();
  // Cohort net was -100k a day ago (prior data present, coin absent → 0... use explicit entry)
  const map24h = new Map([
    ["BTC", point({ longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0 })],
  ]);
  // netDelta24h = 400_000 - 0 = 400_000 (positive, > 250k)
  const crowd = new Map<string, number | null>([["BTC", -5.2]]); // crowd shrinking OI → negative sign

  const rows = computeSmartFlowRows(nowMap, map1h, map24h, crowd);
  const btc = findCoin(rows, "BTC");
  assert.equal(btc?.netDelta24h, 400_000);
  assert.equal(btc?.diverging, true);
});

test("diverging: false when signs disagree but |netDelta24h| is under the $250k gate", () => {
  const nowMap = new Map([
    ["ETH", point({ longUsd: 60_000, shortUsd: 0, netUsd: 60_000, wallets: 1 })],
  ]);
  const map24h = new Map([
    ["ETH", point({ longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0 })],
  ]);
  const crowd = new Map<string, number | null>([["ETH", -1.0]]);

  const rows = computeSmartFlowRows(nowMap, new Map(), map24h, crowd);
  const eth = findCoin(rows, "ETH");
  assert.equal(eth?.netDelta24h, 60_000, "under the $250k gate");
  assert.equal(eth?.diverging, false);
});

test("diverging: false when signs agree, regardless of magnitude", () => {
  const nowMap = new Map([
    ["SOL", point({ longUsd: 500_000, shortUsd: 0, netUsd: 500_000, wallets: 2 })],
  ]);
  const map24h = new Map([
    ["SOL", point({ longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0 })],
  ]);
  const crowd = new Map<string, number | null>([["SOL", 3.4]]); // crowd also adding → same sign

  const rows = computeSmartFlowRows(nowMap, new Map(), map24h, crowd);
  assert.equal(findCoin(rows, "SOL")?.diverging, false);
});

test("diverging: false (null propagation) when netDelta24h is null even if crowd is set", () => {
  const nowMap = new Map([
    ["AVAX", point({ longUsd: 900_000, shortUsd: 0, netUsd: 900_000, wallets: 3 })],
  ]);
  const crowd = new Map<string, number | null>([["AVAX", -9.9]]);
  const rows = computeSmartFlowRows(nowMap, new Map(), new Map(), crowd); // empty 24h map → null delta
  const avax = findCoin(rows, "AVAX");
  assert.equal(avax?.netDelta24h, null);
  assert.equal(avax?.diverging, false, "null delta must never be treated as divergent");
});

test("diverging: false (null propagation) when crowdOiChange24hPct is null (cold markets cache)", () => {
  const nowMap = new Map([
    ["DOGE", point({ longUsd: 900_000, shortUsd: 0, netUsd: 900_000, wallets: 3 })],
  ]);
  const map24h = new Map([
    ["DOGE", point({ longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0 })],
  ]);
  const rows = computeSmartFlowRows(nowMap, new Map(), map24h, new Map()); // no crowd data at all
  const doge = findCoin(rows, "DOGE");
  assert.equal(doge?.crowdOiChange24hPct, null);
  assert.equal(doge?.diverging, false);
});

test("sorted by |netDelta24h| desc when historical data is present", () => {
  const nowMap = new Map([
    ["A", point({ longUsd: 100_000, shortUsd: 0, netUsd: 100_000, wallets: 1 })], // delta 100k
    ["B", point({ longUsd: 900_000, shortUsd: 0, netUsd: 900_000, wallets: 1 })], // absent from map24h → prior 0 → delta 900k
    ["C", point({ longUsd: 500_000, shortUsd: 0, netUsd: 500_000, wallets: 1 })], // 500k - 1M = -500k
  ]);
  const map24h = new Map([
    ["A", point({ longUsd: 0, shortUsd: 0, netUsd: 0, wallets: 0 })],
    ["C", point({ longUsd: 0, shortUsd: 0, netUsd: 1_000_000, wallets: 1 })],
  ]);
  const rows = computeSmartFlowRows(nowMap, new Map(), map24h, new Map());
  assert.deepEqual(rows.map((r) => r.coin), ["B", "C", "A"], "|900k| > |500k| > |100k|");
});

// Because null only fires when the WHOLE historical map is empty (poller
// too young cohort-wide — see priorNet's comment in smartFlow.ts), null
// and non-null deltas can never mix within a single response: either the
// map has data and every coin resolves to a real number (0 if absent), or
// the map is empty and every coin in nowMap is null together. This test
// covers that "everyone null" branch of the nulls-last sort; a genuinely
// mixed null/non-null input is not producible via smartFlowAt's contract.
test("when the historical map is entirely empty, every coin's delta is null together", () => {
  const nowMap = new Map([
    ["A", point({ longUsd: 100_000, shortUsd: 0, netUsd: 100_000, wallets: 1 })],
    ["B", point({ longUsd: 900_000, shortUsd: 0, netUsd: 900_000, wallets: 1 })],
  ]);
  const rows = computeSmartFlowRows(nowMap, new Map(), new Map(), new Map());
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.netDelta24h === null));
});

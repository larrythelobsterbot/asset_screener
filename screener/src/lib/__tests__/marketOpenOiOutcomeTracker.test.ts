import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMarketOpenOiOutcomes,
  type MarketOpenOiOutcomeTrackerDeps,
} from "../marketOpenOiOutcomeTracker";

test("records open and due forward marks with returns anchored to the cash open", () => {
  const openAt = 1_000_000;
  const writes: Array<{ horizon: string; mark: number | null; return_pct: number | null; status: string }> = [];
  const deps: MarketOpenOiOutcomeTrackerDeps = {
    listPending: () => [{ itemId: 1, symbol: "BTC", openAt }],
    listExisting: () => [],
    snapshot: (target) => new Map([["BTC", {
      ts: target - 1_000,
      mark: target === openAt ? 100 : 110,
      oi: 1,
      funding: 0,
      volume: 1,
    }]]),
    insert: (row) => { writes.push(row); return true; },
    now: () => openAt + 60 * 60_000 + 11 * 60_000,
  };

  const result = evaluateMarketOpenOiOutcomes(deps);
  assert.deepEqual(writes.map((row) => row.horizon), ["open", "1h"]);
  assert.deepEqual(writes.map((row) => row.status), ["observed", "observed"]);
  assert.equal(writes[0].return_pct, null);
  assert.ok(Math.abs((writes[1].return_pct ?? 0) - 10) < 1e-9);
  assert.deepEqual(result, { scanned: 1, inserted: 2, missing: 0, untrackable: 0, errors: 0 });
});

test("records missing open evidence and makes later returns explicitly untrackable", () => {
  const openAt = 2_000_000;
  const writes: Array<{ horizon: string; status: string }> = [];
  const deps: MarketOpenOiOutcomeTrackerDeps = {
    listPending: () => [{ itemId: 2, symbol: "ETH", openAt }],
    listExisting: () => [],
    snapshot: (target) => target === openAt
      ? new Map()
      : new Map([["ETH", { ts: target, mark: 110, oi: 1, funding: 0, volume: 1 }]]),
    insert: (row) => { writes.push(row); return true; },
    now: () => openAt + 60 * 60_000 + 11 * 60_000,
  };

  const result = evaluateMarketOpenOiOutcomes(deps);
  assert.deepEqual(writes.map(({ horizon, status }) => ({ horizon, status })), [
    { horizon: "open", status: "missing" },
    { horizon: "1h", status: "untrackable" },
  ]);
  assert.equal(result.missing, 1);
  assert.equal(result.untrackable, 1);
});

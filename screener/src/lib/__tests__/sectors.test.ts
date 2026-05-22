// sectorOf / priorityOf — sanity test that the new ticker→sector
// resolver lands on the right bucket for each of the three sources
// (native HL perp, builder DEX, HIP-3 spot stock).

import { test } from "node:test";
import assert from "node:assert/strict";
import { sectorOf, priorityOf } from "../../config/sectors";

test("sectorOf: native HL perp", () => {
  assert.equal(sectorOf("BTC"), "majors");
  assert.equal(sectorOf("HYPE"), "l1");
  assert.equal(sectorOf("PAXG"), "commodities");
});

test("sectorOf: HIP-3 spot stock (bare ticker)", () => {
  // From HL_SPOT_STOCKS — TSLA is the ticker for @264.
  assert.equal(sectorOf("TSLA"), "stocks");
  assert.equal(sectorOf("GLD"), "commodities");
});

test("sectorOf: builder DEX entry (first wins by precedence)", () => {
  // ARM was added in the audit pass — only xyz:ARM exists.
  assert.equal(sectorOf("ARM"), "stocks");
  // CORN — commodity.
  assert.equal(sectorOf("CORN"), "commodities");
  // NIFTY — index.
  assert.equal(sectorOf("NIFTY"), "indices");
});

test("sectorOf: unknown ticker falls back to crypto-alt", () => {
  assert.equal(sectorOf("__DEFINITELYNOTREAL__"), "crypto-alt");
});

test("priorityOf: prioritized sectors return > 1", () => {
  assert.ok(priorityOf("CORN") > 1, "commodities should be boosted");
  assert.ok(priorityOf("ARM") > 1, "stocks should be boosted");
  assert.ok(priorityOf("NIFTY") > 1, "indices should be boosted");
});

test("priorityOf: default sectors return 1", () => {
  assert.equal(priorityOf("BTC"), 1, "majors are baseline");
  assert.equal(priorityOf("HYPE"), 1, "l1 is baseline");
});

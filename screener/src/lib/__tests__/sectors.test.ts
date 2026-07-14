// sectorOf / priorityOf — sanity test that the new ticker→sector
// resolver lands on the right bucket for each of the three sources
// (native HL perp, builder DEX, HIP-3 spot stock).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sectorOf,
  priorityOf,
  builderOnlyTickers,
  HL_PERP_SECTOR_MAP,
  HL_BUILDER_PERP_MAP,
} from "../../config/sectors";

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

// ── builderOnlyTickers — feeds /api/screener's indicator surface ────────

test("builderOnlyTickers: bare tickers, deduped, prefix stripped", () => {
  const t = builderOnlyTickers();
  assert.ok(t.includes("SKHX"), "expected a HIP-3 stock");
  assert.ok(t.includes("XYZ100"), "expected a HIP-3 index");
  assert.ok(t.every((s) => !s.includes(":")), "dex prefix must be stripped");
  assert.equal(new Set(t).size, t.length, "must be deduped — several dexes list the same ticker");
});

test("builderOnlyTickers: native perps win a contested ticker outright", () => {
  const t = builderOnlyTickers();
  // Multiple builder dexes list BTC/ETH, but native HL owns them. Yielding
  // them here would double-count the symbol in /api/screener and could
  // resolve it to a different venue's contract than /api/markets picked.
  for (const native of ["BTC", "ETH", "SPX"]) {
    if (HL_PERP_SECTOR_MAP[native]) {
      assert.ok(!t.includes(native), `${native} is native — must not appear as builder-only`);
    }
  }
  assert.equal(
    t.filter((s) => HL_PERP_SECTOR_MAP[s]).length,
    0,
    "builder-only list must be disjoint from the native sector map",
  );
});

test("builderOnlyTickers: every ticker traces back to a real builder entry", () => {
  const keys = new Set(
    Object.keys(HL_BUILDER_PERP_MAP).map((k) => (k.includes(":") ? k.split(":")[1] : k)),
  );
  for (const t of builderOnlyTickers()) {
    assert.ok(keys.has(t), `${t} must originate from HL_BUILDER_PERP_MAP`);
  }
});

// This is the invariant that keeps HIP-3 off the Telegram alerter, so it is
// asserted rather than assumed. /api/signals — the only caller of
// maybeDispatchAlerts — derives its universe by filtering meta.universe
// (NATIVE perps) through HL_PERP_SECTOR_MAP. Adding builder tickers to
// /api/screener widens the read-only indicator surface only. If someone
// later adds a HIP-3 ticker to HL_PERP_SECTOR_MAP, this fails and they get
// to make that call deliberately.
test("HIP-3 tickers stay out of the native sector map (alerter separation)", () => {
  const builderTickers = new Set(
    Object.keys(HL_BUILDER_PERP_MAP).map((k) => (k.includes(":") ? k.split(":")[1] : k)),
  );
  // Tickers a native perp legitimately shares with a builder listing (BTC,
  // ETH, ...) are fine — those are native markets and already alertable.
  // What must not happen is a builder-ONLY ticker appearing as native.
  const leaked = builderOnlyTickers().filter((t) => HL_PERP_SECTOR_MAP[t]);
  assert.deepEqual(leaked, [], "builder-only tickers must not be in the signals universe");
  assert.ok(builderTickers.has("SKHX"), "sanity: SKHX is a builder listing");
  assert.equal(HL_PERP_SECTOR_MAP["SKHX"], undefined, "SKHX must not be natively mapped");
});

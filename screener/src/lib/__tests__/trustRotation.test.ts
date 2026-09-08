import { strict as assert } from "node:assert";
import { test } from "node:test";
import { marketContract } from "../marketContract";
import { parseDerivsPayload } from "../marketPolling";

test("canonical contract identity preserves native and selected HIP-3 wire names", () => {
  assert.deepEqual(marketContract("BTC"), {
    kind: "native",
    dex: null,
    wireCoin: "BTC",
    historyKey: "BTC",
  });
  assert.deepEqual(marketContract("SKHX", "xyz"), {
    kind: "hip3",
    dex: "xyz",
    wireCoin: "xyz:SKHX",
    historyKey: "SKHX",
  });
});

test("invalid derivs bodies are rejected and metadata is required", () => {
  assert.equal(parseDerivsPayload(null), null);
  assert.equal(parseDerivsPayload({ items: [] }), null);
  assert.equal(parseDerivsPayload({ items: [], metadata: { generatedAt: 1, sourceObservedAt: 1, ageMs: 0, status: "fresh", stale: false } })?.items.length, 0);
  assert.equal(parseDerivsPayload({
    items: [{
      base: "BTC",
      contract: marketContract("BTC"),
      price: Number.NaN,
      oiUsd: 1,
      oiCoins: 1,
      volume24h: 1,
      observationAt: 1,
      priceDeltaPct: null,
      oiDeltaPct: null,
      oiCoinsChangePct: null,
      oiQuantityDeltaUsd: null,
      observationAgeMs: null,
      observationStatus: "unavailable",
      quadrant: "unavailable",
      spark: { px: [], oi: [], oiCoins: [] },
    }],
    metadata: {
      generatedAt: 1,
      sourceObservedAt: 1,
      ageMs: 0,
      status: "fresh",
      stale: false,
    },
  }), null);
});

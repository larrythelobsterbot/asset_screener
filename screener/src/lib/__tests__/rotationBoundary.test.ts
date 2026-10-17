import "./db-test-setup";
import assert from "node:assert/strict";
import test from "node:test";
import { buildRotationMetric, isRotationPayload, ROTATION_WINDOWS, rotationWindowMs } from "../rotation";
import { buildRotationPayload, getRotationSnapshot } from "../rotationService";
import { cache } from "../cache";
import { BUILDER_DEXES } from "@/config/sectors";

const now = 1_800_000_000_000;
const current = { ts: now, mark: 120, oi: 12, funding: 0.00001 };

test("every rotation horizon rejects too-recent and too-old observations", () => {
  for (const horizon of ROTATION_WINDOWS) {
    const target = now - rotationWindowMs(horizon);
    const point = { ts: target, mark: 100, oi: 10, funding: 0 };
    assert.equal(buildRotationMetric(horizon, current, point, "BTC").status, "observed");
    for (const ts of [now, target + 600_001, target - 600_001]) {
      const invalid = buildRotationMetric(horizon, current, { ...point, ts }, "BTC");
      assert.equal(invalid.pricePct, null, `${horizon} at ${ts}`);
      assert.equal(invalid.oiCoinPct, null, `${horizon} at ${ts}`);
    }
  }
});

test("contract percentage overflow is unavailable, not observed-null", () => {
  const metric = buildRotationMetric("1h", { ...current, oi: 1e308 },
    { ts: now - 3_600_000, mark: 100, oi: Number.MIN_VALUE, funding: 0 }, "BTC");
  assert.equal(metric.oiCoinPct, null);
  assert.equal(metric.oiStatus, "unavailable");
  assert.notEqual(metric.status, "observed");
});

test("quiet native owns ticker, but ghost builder cannot mask a later live listing", async () => {
  assert.ok(BUILDER_DEXES.length >= 2);
  const ctx = (price: string, volume: string) => ({ markPx: price, dayNtlVlm: volume, openInterest: "10", funding: "0" });
  cache.set("hl:metaAndCtxs", { meta: { universe: [{ name: "NATIVE" }] }, assetCtxs: [ctx("0", "0")] }, 60_000);
  for (const [index, dex] of BUILDER_DEXES.entries()) {
    cache.set(`hl:builderDex:${dex}`, {
      meta: { universe: index < 2 ? ["GHOST", "NATIVE", "MALFORMED", "EMPTYMARK"].map(name => ({ name: `${dex}:${name}` })) : [] },
      assetCtxs: index < 2 ? [ctx(index === 0 ? "0" : "100", index === 0 ? "0" : "10000"), ctx("200", "10000"), ctx(index === 0 ? "NaN" : "100", "10000"), ctx(index === 0 ? "" : "100", "10000")] : [],
    }, 60_000);
  }
  const payload = await getRotationSnapshot();
  assert.equal(payload.rows.find((row) => row.symbol === "GHOST")?.contract.dex, BUILDER_DEXES[1]);
  assert.equal(payload.rows.some((row) => row.symbol === "NATIVE"), false);
  assert.equal(payload.rows.some(row => row.symbol === "MALFORMED"), false, "do not splice later venue onto malformed first-owner history");
  assert.equal(payload.rows.find(row => row.symbol === "EMPTYMARK")?.contract.dex, BUILDER_DEXES[1]);
});

test("client validator rejects observed metrics outside their claimed lookback", () => {
  const payload = buildRotationPayload({
    now,
    assets: [{ symbol: "BTC", name: "BTC", contract: { kind: "native", dex: null, wireCoin: "BTC", historyKey: "BTC" }, current, volume24h: 1000 }],
    historicalSnapshot: target => new Map([["BTC", { ts: target, mark: 100, oi: 10, prev_day: null, funding: 0, volume: null }]]),
    candles: () => new Map(),
  });
  assert.equal(isRotationPayload(payload), true);
  payload.rows[0].windows["7d"].priorTs = now - 1;
  assert.equal(isRotationPayload(payload), false);
  Object.assign(payload.rows[0].windows["7d"], {
    status: "unavailable", pricePct: null, priceStatus: "unavailable",
    oiCoinPct: null, oiStatus: "unavailable", quantityEffectUsd: null, quantityEffectStatus: "unavailable",
    oiUsdDelta: null, oiUsdDeltaStatus: "unavailable",
  });
  assert.equal(isRotationPayload(payload), false, "funding-only observation must obey the same horizon bounds");
});

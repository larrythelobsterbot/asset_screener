import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchAssetDetailMarketData,
  selectAssetPerpContext,
  type AssetDetailMarketDependencies,
} from "../assetDetailMarket";
import { resolveAssetMarketIdentity } from "../assetMarketIdentity";
import type { HLAssetCtx, HLCandle, HLMeta } from "../hyperliquid";

const candle: HLCandle = {
  t: 1,
  T: 2,
  o: "1",
  h: "2",
  l: "0.5",
  c: "1.5",
  v: "10",
  n: 1,
};

function ctx(markPx: string): HLAssetCtx {
  return {
    funding: "0.0001",
    openInterest: "100",
    prevDayPx: "1",
    dayNtlVlm: "1000",
    premium: "0",
    oraclePx: markPx,
    markPx,
  };
}

function meta(...names: string[]): HLMeta {
  return {
    universe: names.map((name) => ({ name, szDecimals: 2, maxLeverage: 10 })),
  };
}

function dependencies(overrides: Partial<AssetDetailMarketDependencies> = {}): AssetDetailMarketDependencies {
  return {
    getCandles: async () => [candle],
    getFundingHistory: async (coin) => [{
      coin,
      fundingRate: "0.0001",
      premium: "0",
      time: 1,
    }],
    getMetaAndCtxs: async () => ({ meta: meta("BTC"), assetCtxs: [ctx("100")] }),
    getAllMids: async () => ({}),
    getBuilderDexData: async () => ({
      meta: meta("xyz:OTHER", "xyz:SKHX"),
      assetCtxs: [ctx("1"), ctx("1010")],
    }),
    ...overrides,
  };
}

test("SKHX route data uses xyz:SKHX for candles and funding and xyz metadata", async () => {
  const market = resolveAssetMarketIdentity("SKHX");
  assert.ok(market);

  const candleCalls: unknown[][] = [];
  const fundingCalls: string[] = [];
  const builderCalls: string[] = [];
  const deps = dependencies({
    getCandles: async (...args) => {
      candleCalls.push(args);
      return [candle];
    },
    getFundingHistory: async (coin) => {
      fundingCalls.push(coin);
      return [{ coin, fundingRate: "0.0001", premium: "0", time: 1 }];
    },
    getBuilderDexData: async (dex) => {
      builderCalls.push(dex);
      return {
        meta: meta("xyz:OTHER", "xyz:SKHX"),
        assetCtxs: [ctx("1"), ctx("1010")],
      };
    },
  });

  const data = await fetchAssetDetailMarketData(market, deps);
  assert.deepEqual(candleCalls, [["xyz:SKHX", "4h", 350, "SKHX"]]);
  assert.deepEqual(fundingCalls, ["xyz:SKHX"]);
  assert.deepEqual(builderCalls, ["xyz"]);
  assert.equal(selectAssetPerpContext(market, data)?.markPx, "1010");
});

test("builder metadata selection accepts the qualified or bare row name after DEX resolution", async () => {
  const market = resolveAssetMarketIdentity("SKHX");
  assert.ok(market);

  const qualified = await fetchAssetDetailMarketData(market, dependencies());
  assert.equal(selectAssetPerpContext(market, qualified)?.markPx, "1010");

  const bare = await fetchAssetDetailMarketData(market, dependencies({
    getBuilderDexData: async () => ({ meta: meta("SKHX"), assetCtxs: [ctx("1009")] }),
  }));
  assert.equal(selectAssetPerpContext(market, bare)?.markPx, "1009");
});

test("native and spot request plans preserve their existing upstream identities", async () => {
  const candleCalls: unknown[][] = [];
  const fundingCalls: string[] = [];
  const builderCalls: string[] = [];
  const deps = dependencies({
    getCandles: async (...args) => {
      candleCalls.push(args);
      return [candle];
    },
    getFundingHistory: async (coin) => {
      fundingCalls.push(coin);
      return [];
    },
    getBuilderDexData: async (dex) => {
      builderCalls.push(dex);
      return { meta: meta(), assetCtxs: [] };
    },
  });

  const btc = resolveAssetMarketIdentity("BTC");
  const spot = resolveAssetMarketIdentity("META");
  assert.ok(btc);
  assert.ok(spot);
  await fetchAssetDetailMarketData(btc, deps);
  await fetchAssetDetailMarketData(spot, deps);

  assert.deepEqual(candleCalls, [
    ["BTC", "4h", 350, "BTC"],
    [spot.wireCoin, "4h", 350, spot.wireCoin],
  ]);
  assert.deepEqual(fundingCalls, ["BTC"]);
  assert.deepEqual(builderCalls, []);
});

test("candle, funding, and builder metadata failures retain the route's partial-response policy", async () => {
  const market = resolveAssetMarketIdentity("SKHX");
  assert.ok(market);

  const data = await fetchAssetDetailMarketData(market, dependencies({
    getCandles: async () => { throw new Error("candles unavailable"); },
    getFundingHistory: async () => { throw new Error("funding unavailable"); },
    getBuilderDexData: async () => { throw new Error("builder unavailable"); },
  }));

  assert.deepEqual(data.candles, []);
  assert.deepEqual(data.funding, []);
  assert.equal(data.builderData, null);
  assert.equal(selectAssetPerpContext(market, data), null);
});

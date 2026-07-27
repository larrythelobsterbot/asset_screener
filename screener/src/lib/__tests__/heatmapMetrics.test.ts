import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AssetData } from "@/lib/types";
import {
  getHeatmapColorValue,
  getHeatmapWeight,
} from "@/lib/heatmapMetrics";

function asset(overrides: Partial<AssetData> = {}): AssetData {
  return {
    symbol: "HYPE",
    name: "Hyperliquid",
    sector: "l1",
    sectorColor: "#fff",
    price: 40,
    change1h: 1,
    change4h: -2,
    change24h: 3,
    change7d: 8,
    volume24h: 100_000_000,
    fundingRate: 0.0001,
    openInterest: 2_000_000,
    markPrice: 40,
    oraclePrice: 40,
    source: "hyperliquid",
    oiUsd: 80_000_000,
    oiChange24hUsd: 8_000_000,
    oiChange24hPct: 10,
    oiChange7dUsd: null,
    oiChange7dPct: null,
    fundingAvg24h: 0.00005,
    volOiRatio: 1.25,
    ...overrides,
  };
}

test("heatmap price color follows the selected timeframe", () => {
  const value = getHeatmapColorValue(asset(), "price", "4h");
  assert.deepEqual(value, {
    tone: -2,
    display: "-2.00%",
    tooltip: "4h price change",
  });
});

test("OI heat color is based on percentage change and fails closed when unavailable", () => {
  assert.deepEqual(getHeatmapColorValue(asset(), "oi-change", "24h"), {
    tone: 10,
    display: "+10.00%",
    tooltip: "24h open-interest change",
  });
  assert.deepEqual(
    getHeatmapColorValue(asset({ oiChange24hPct: null }), "oi-change", "24h"),
    { tone: null, display: "—", tooltip: "24h open-interest change" },
  );
});

test("funding color inverts the tone because positive funding means crowded longs", () => {
  const value = getHeatmapColorValue(asset(), "funding", "24h");
  assert.equal(value.tone, -43.8);
  assert.equal(value.display, "+43.80%");
  assert.equal(value.tooltip, "24h mean funding APR");
});

test("tile size can use volume, dollar OI, or equal weight", () => {
  assert.ok(getHeatmapWeight(asset(), "volume") > getHeatmapWeight(asset({ volume24h: 1_000_000 }), "volume"));
  assert.ok(getHeatmapWeight(asset(), "oi") > getHeatmapWeight(asset({ oiUsd: null }), "oi"));
  assert.equal(getHeatmapWeight(asset(), "equal"), 1);
});

test("non-finite color and size inputs fail closed", () => {
  const invalid = asset({
    change24h: Number.NaN,
    oiChange24hPct: Number.POSITIVE_INFINITY,
    fundingAvg24h: Number.NEGATIVE_INFINITY,
    volume24h: Number.NaN,
    oiUsd: Number.POSITIVE_INFINITY,
  });

  assert.deepEqual(getHeatmapColorValue(invalid, "price", "24h"), {
    tone: null,
    display: "—",
    tooltip: "24h price change",
  });
  assert.deepEqual(getHeatmapColorValue(invalid, "oi-change", "24h"), {
    tone: null,
    display: "—",
    tooltip: "24h open-interest change",
  });
  assert.equal(getHeatmapColorValue(invalid, "funding", "24h").tone, null);
  assert.equal(getHeatmapWeight(invalid, "volume"), 0.05);
  assert.equal(getHeatmapWeight(invalid, "oi"), 0.05);
});

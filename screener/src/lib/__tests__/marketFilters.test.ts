import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AssetData } from "@/lib/types";
import {
  clearActiveFilter,
  DEFAULT_FILTERS,
  FILTER_PRESETS,
  getActiveFilters,
  parseStoredFilters,
  passesFilters,
  type FilterState,
} from "@/lib/useFilters";

function asset(overrides: Partial<AssetData> = {}): AssetData {
  return {
    symbol: "TEST",
    name: "Test Asset",
    sector: "l1",
    sectorColor: "#fff",
    price: 10,
    change1h: 1,
    change4h: 2,
    change24h: 3,
    change7d: 4,
    volume24h: 20_000_000,
    fundingRate: 0.0001,
    openInterest: 2_000,
    markPrice: 10,
    oraclePrice: 10,
    source: "hyperliquid",
    oiUsd: 20_000,
    oiChange24hUsd: 2_000,
    oiChange24hPct: 10,
    oiChange7dUsd: 4_000,
    oiChange7dPct: 20,
    fundingAvg24h: 0.00005,
    volOiRatio: 1.5,
    ...overrides,
  };
}

test("minimum OI filters on dollar OI rather than coin quantity", () => {
  const filters: FilterState = { ...DEFAULT_FILTERS, minOIUsd: 1_000_000 };

  assert.equal(
    passesFilters(asset({ openInterest: 2_000_000, oiUsd: 20_000 }), filters, "24h"),
    false,
  );
  assert.equal(
    passesFilters(asset({ openInterest: 2, oiUsd: 2_000_000 }), filters, "24h"),
    true,
  );
});

test("minimum OI excludes assets without derivatives OI", () => {
  const filters: FilterState = { ...DEFAULT_FILTERS, minOIUsd: 1_000_000 };

  assert.equal(
    passesFilters(
      asset({ source: "coingecko", openInterest: null, oiUsd: null }),
      filters,
      "24h",
    ),
    false,
  );
});

test("active volume and OI filters fail closed on non-finite values", () => {
  assert.equal(
    passesFilters(asset({ volume24h: Number.NaN }), { ...DEFAULT_FILTERS, minVolume: 1 }),
    false,
  );
  assert.equal(
    passesFilters(asset({ oiUsd: Number.NaN }), { ...DEFAULT_FILTERS, minOIUsd: 1 }),
    false,
  );
});

test("stored filters use a validated versioned envelope", () => {
  const parsed = parseStoredFilters(JSON.stringify({
    version: 1,
    filters: {
      ...DEFAULT_FILTERS,
      minVolume: 10_000_000,
      minOIUsd: 5_000_000,
      sectors: ["l1", "l1", "not-a-sector"],
      sources: ["hyperliquid", "not-a-source"],
    },
  }));

  assert.equal(parsed.minVolume, 10_000_000);
  assert.equal(parsed.minOIUsd, 5_000_000);
  assert.deepEqual(parsed.sectors, ["l1"]);
  assert.deepEqual(parsed.sources, ["hyperliquid"]);
});

test("stored filters reject unsafe thresholds, unknown versions, and legacy coin OI", () => {
  const invalid = parseStoredFilters(JSON.stringify({
    version: 1,
    filters: {
      ...DEFAULT_FILTERS,
      minVolume: -1,
      minOIUsd: "5000000",
      minVolOiRatio: 4,
      maxVolOiRatio: 2,
    },
  }));
  assert.equal(invalid.minVolume, null);
  assert.equal(invalid.minOIUsd, null);
  assert.equal(invalid.minVolOiRatio, null);
  assert.equal(invalid.maxVolOiRatio, null);

  assert.deepEqual(
    parseStoredFilters(JSON.stringify({ version: 99, filters: { minVolume: 1 } })),
    DEFAULT_FILTERS,
  );
  assert.deepEqual(
    parseStoredFilters(JSON.stringify({ minVolume: 1_000_000, minOI: 5_000_000 })),
    { ...DEFAULT_FILTERS, minVolume: 1_000_000 },
  );
});

test("universe filters require a selected sector and source", () => {
  const filters: FilterState = {
    ...DEFAULT_FILTERS,
    sectors: ["l1"],
    sources: ["hyperliquid"],
  };

  assert.equal(passesFilters(asset(), filters, "24h"), true);
  assert.equal(passesFilters(asset({ sector: "meme" }), filters, "24h"), false);
  assert.equal(
    passesFilters(asset({ source: "coingecko" }), filters, "24h"),
    false,
  );
});

test("price-move filters use the selected timeframe and fail closed on missing data", () => {
  const filters = {
    ...DEFAULT_FILTERS,
    moveDirection: "up" as const,
    minAbsMovePct: 5,
  };
  const mixed = asset({ change1h: 6, change24h: -10 });

  assert.equal(passesFilters(mixed, filters, "1h"), true);
  assert.equal(passesFilters(mixed, filters, "24h"), false);
  assert.equal(passesFilters(asset({ change4h: null }), filters, "4h"), false);
});

test("OI trend filters require the requested direction and magnitude", () => {
  const filters = {
    ...DEFAULT_FILTERS,
    oiTrend: "rising" as const,
    minAbsOIChange24hPct: 8,
  };

  assert.equal(passesFilters(asset({ oiChange24hPct: 10 }), filters), true);
  assert.equal(passesFilters(asset({ oiChange24hPct: 5 }), filters), false);
  assert.equal(passesFilters(asset({ oiChange24hPct: -12 }), filters), false);
  assert.equal(passesFilters(asset({ oiChange24hPct: null }), filters), false);
});

test("funding filters use annualized average funding and fail closed", () => {
  const filters = {
    ...DEFAULT_FILTERS,
    fundingBias: "positive" as const,
    minAbsFundingAprPct: 25,
  };

  assert.equal(passesFilters(asset({ fundingAvg24h: 0.00005 }), filters), true);
  assert.equal(passesFilters(asset({ fundingAvg24h: 0.00001 }), filters), false);
  assert.equal(passesFilters(asset({ fundingAvg24h: -0.00005 }), filters), false);
  assert.equal(passesFilters(asset({ fundingAvg24h: null }), filters), false);
});

test("volume-to-OI filters enforce both bounds and fail closed", () => {
  const filters = {
    ...DEFAULT_FILTERS,
    minVolOiRatio: 1,
    maxVolOiRatio: 3,
  };

  assert.equal(passesFilters(asset({ volOiRatio: 1.5 }), filters), true);
  assert.equal(passesFilters(asset({ volOiRatio: 0.5 }), filters), false);
  assert.equal(passesFilters(asset({ volOiRatio: 4 }), filters), false);
  assert.equal(passesFilters(asset({ volOiRatio: null }), filters), false);
});

test("active filter descriptors are readable and individually removable", () => {
  const filters: FilterState = {
    ...DEFAULT_FILTERS,
    minVolume: 10_000_000,
    sectors: ["l1", "meme"],
    moveDirection: "down",
    minAbsMovePct: 5,
  };

  assert.deepEqual(
    getActiveFilters(filters, "4h").map(({ key, label }) => ({ key, label })),
    [
      { key: "sectors", label: "Sectors: 2" },
      { key: "minVolume", label: "Volume ≥ $10M" },
      { key: "moveDirection", label: "4h losers" },
      { key: "minAbsMovePct", label: "4h move ≥ 5%" },
    ],
  );

  const cleared = clearActiveFilter(filters, "sectors");
  assert.deepEqual(cleared.sectors, []);
  assert.deepEqual(filters.sectors, ["l1", "meme"], "clear must not mutate state");
});

test("saved presets are transparent combinations of the same filter rules", () => {
  const liquid = FILTER_PRESETS.find((preset) => preset.id === "liquid-perps");
  const oiExpansion = FILTER_PRESETS.find((preset) => preset.id === "oi-expansion");
  assert.ok(liquid);
  assert.ok(oiExpansion);

  assert.equal(
    passesFilters(asset({ volume24h: 20_000_000, oiUsd: 10_000_000 }), liquid.filters),
    true,
  );
  assert.equal(
    passesFilters(asset({ source: "coingecko", oiUsd: null }), liquid.filters),
    false,
  );
  assert.equal(
    passesFilters(asset({ oiUsd: 2_000_000, oiChange24hPct: 8 }), oiExpansion.filters),
    true,
  );
  assert.equal(
    passesFilters(asset({ oiUsd: 2_000_000, oiChange24hPct: -8 }), oiExpansion.filters),
    false,
  );
});

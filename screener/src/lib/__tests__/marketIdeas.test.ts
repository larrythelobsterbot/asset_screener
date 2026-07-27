import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AssetData } from "@/lib/types";
import type { Signal } from "@/lib/signals";
import {
  buildMarketIdeas,
  DEFAULT_IDEA_FILTERS,
  filterMarketIdeas,
} from "@/lib/marketIdeas";

function asset(symbol: string, overrides: Partial<AssetData> = {}): AssetData {
  return {
    symbol,
    name: symbol,
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
    oiUsd: 20_000_000,
    oiChange24hUsd: 2_000_000,
    oiChange24hPct: 10,
    oiChange7dUsd: 4_000_000,
    oiChange7dPct: 20,
    fundingAvg24h: 0.00005,
    volOiRatio: 1.5,
    ...overrides,
  };
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    symbol: "HYPE",
    type: "breakout_up",
    family: "structure",
    direction: "bullish",
    value: 1,
    label: "Range breakout",
    firedAt: 1_000_000,
    timeframe: "4h",
    ...overrides,
  };
}

test("market ideas group evidence by symbol and rank signalled assets first", () => {
  const ideas = buildMarketIdeas(
    [asset("BTC"), asset("HYPE")],
    [
      signal(),
      signal({ type: "ema_bullish", family: "trend", label: "EMA stack" }),
      signal({ type: "rsi_overbought", family: "momentum", direction: "bearish", label: "RSI overbought" }),
    ],
    "24h",
  );

  assert.equal(ideas[0].asset.symbol, "HYPE");
  assert.equal(ideas[0].direction, "conflict");
  assert.equal(ideas[0].familyCount, 3);
  assert.equal(ideas[0].signalCount, 3);
  assert.deepEqual(
    ideas[0].reasons.slice(0, 3).map((reason) => reason.label),
    ["4h Range breakout", "4h EMA stack", "4h RSI overbought"],
  );
});

test("idea filters can isolate directional fresh signal evidence", () => {
  const ideas = buildMarketIdeas(
    [asset("BTC"), asset("HYPE")],
    [signal({ firedAt: 1_000_000 })],
    "24h",
  );

  assert.deepEqual(
    filterMarketIdeas(ideas, {
      direction: "bullish",
      evidence: "signals",
      maxSignalAgeHours: 1,
    }, 1_000_000 + 30 * 60_000).map((idea) => idea.asset.symbol),
    ["HYPE"],
  );
  assert.deepEqual(
    filterMarketIdeas(ideas, {
      direction: "bullish",
      evidence: "signals",
      maxSignalAgeHours: 1,
    }, 1_000_000 + 2 * 60 * 60_000),
    [],
  );
});

test("invalid signal timestamps are excluded before sorting and rendering", () => {
  const ideas = buildMarketIdeas(
    [asset("HYPE")],
    [signal({ firedAt: Number.NaN })],
    "24h",
  );

  assert.equal(ideas[0].signalCount, 0);
  assert.equal(ideas[0].latestSignalAt, null);
  assert.equal(ideas[0].reasons.some((reason) => reason.kind === "signal"), false);
});

test("the default actionable lens keeps signals or multi-factor anomalies", () => {
  const quiet = asset("QUIET", {
    change24h: 0,
    oiChange24hPct: 0,
    fundingAvg24h: 0,
    volOiRatio: 1,
  });
  const oneRead = asset("ONE", {
    change24h: 3,
    oiChange24hPct: 0,
    fundingAvg24h: 0,
    volOiRatio: 1,
  });
  const twoReads = asset("TWO", {
    change24h: 3,
    oiChange24hPct: 8,
    fundingAvg24h: 0,
    volOiRatio: 1,
  });
  const signalled = asset("SIG", {
    change24h: 0,
    oiChange24hPct: 0,
    fundingAvg24h: 0,
    volOiRatio: 1,
  });
  const ideas = buildMarketIdeas(
    [quiet, oneRead, twoReads, signalled],
    [signal({ symbol: "SIG" })],
    "24h",
  );

  assert.equal(DEFAULT_IDEA_FILTERS.evidence, "actionable");
  assert.deepEqual(
    filterMarketIdeas(ideas, DEFAULT_IDEA_FILTERS).map((idea) => idea.asset.symbol).sort(),
    ["SIG", "TWO"],
  );
});

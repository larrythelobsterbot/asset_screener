import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveMarketOpenOiItem,
  formatMarketOpenOiTelegram,
  selectMarketOpenOiItems,
  type MarketOpenOiItem,
} from "../marketOpenOi";

function oiItem(
  symbol: string,
  sector: Parameters<typeof deriveMarketOpenOiItem>[0]["sector"],
  priorOi: number,
  currentOi: number,
  options: { priorMark?: number; currentMark?: number; volume?: number } = {},
): MarketOpenOiItem {
  const item = deriveMarketOpenOiItem({
    symbol,
    sector,
    displayScale: 1,
    current: {
      ts: 20_000,
      mark: options.currentMark ?? 100,
      oi: currentOi,
      funding: 0,
      volume: options.volume ?? 10_000_000,
    },
    prior: {
      ts: 10_000,
      mark: options.priorMark ?? 100,
      oi: priorOi,
      funding: 0,
      volume: options.volume ?? 10_000_000,
    },
  });
  assert.ok(item);
  return item;
}

test("derives true contract OI change separately from price-driven USD OI change", () => {
  const item = deriveMarketOpenOiItem({
    symbol: "SCALED",
    sector: "majors",
    displayScale: 100,
    current: {
      ts: 20_000,
      mark: 11_000,
      oi: 120,
      funding: 0.0001,
      volume: 5_000_000,
    },
    prior: {
      ts: 10_000,
      mark: 10_000,
      oi: 100,
      funding: 0.00005,
      volume: 4_000_000,
    },
    smartFlowDeltaUsd: 500_000,
  });

  assert.ok(item);
  assert.equal(item.universe, "crypto");
  assert.equal(item.priorOiUsd, 10_000);
  assert.equal(item.currentOiUsd, 13_200);
  assert.equal(item.oiQuantityDeltaUsd, 2_000);
  assert.equal(item.oiUsdDelta, 3_200);
  assert.equal(item.oiCoinsChangePct, 20);
  assert.equal(item.priceChangePct, 10);
  assert.ok(item.fundingApr != null);
  assert.ok(Math.abs(item.fundingApr - 87.6) < 1e-9);
  assert.equal(item.quadrant, "expanding_up");
  assert.equal(item.smartFlowAlignment, "aligned");
});

test("accepts a full OI unwind but rejects negative OI and sectors outside the briefing universes", () => {
  const unwound = deriveMarketOpenOiItem({
    symbol: "UNWIND",
    sector: "majors",
    displayScale: 1,
    current: { ts: 2, mark: 100, oi: 0, funding: 0, volume: 1_000_000 },
    prior: { ts: 1, mark: 100, oi: 10, funding: 0, volume: 1_000_000 },
  });
  assert.ok(unwound);
  assert.equal(unwound.oiCoinsChangePct, -100);
  assert.equal(unwound.oiQuantityDeltaUsd, -1_000);
  assert.equal(deriveMarketOpenOiItem({
    symbol: "BAD",
    sector: "majors",
    displayScale: 1,
    current: { ts: 2, mark: 100, oi: -1, funding: 0, volume: 1_000_000 },
    prior: { ts: 1, mark: 100, oi: 10, funding: 0, volume: 1_000_000 },
  }), null);
  assert.equal(deriveMarketOpenOiItem({
    symbol: "GOLD",
    sector: "commodities",
    displayScale: 1,
    current: { ts: 2, mark: 100, oi: 20, funding: 0, volume: 1_000_000 },
    prior: { ts: 1, mark: 100, oi: 10, funding: 0, volume: 1_000_000 },
  }), null);
});

test("selects independent top-five crypto and session-relevant equity moves by OI quantity effect", () => {
  const crypto = [6, 5, 4, 3, 2, 1].map((delta, index) =>
    oiItem(`C${index + 1}`, "majors", 100, 100 + delta),
  );
  const asiaEquity = oiItem("SMSN", "stocks", 100, 108);
  const usEquity = oiItem("AAPL", "stocks", 100, 120);

  const selected = selectMarketOpenOiItems(
    [...crypto, asiaEquity, usEquity],
    "asia",
    {
      crypto: { minCurrentOiUsd: 0, minVolume24h: 0, minAbsOiPct: 0, minAbsQuantityDeltaUsd: 0 },
      equity: { minCurrentOiUsd: 0, minVolume24h: 0, minAbsOiPct: 0, minAbsQuantityDeltaUsd: 0 },
      maxPerUniverse: 5,
    },
  );

  assert.deepEqual(selected.crypto.map((item) => item.symbol), ["C1", "C2", "C3", "C4", "C5"]);
  assert.deepEqual(selected.equity.map((item) => item.symbol), ["SMSN"]);
});

test("materiality gates reject price-only OI USD changes and tiny illiquid bases", () => {
  const priceOnly = oiItem("BTC", "majors", 10_000, 10_020, {
    priorMark: 100,
    currentMark: 120,
    volume: 100_000_000,
  });
  const tinyBase = oiItem("TINY", "crypto-alt", 10, 20, {
    priorMark: 1,
    currentMark: 1,
    volume: 100,
  });

  const selected = selectMarketOpenOiItems([priceOnly, tinyBase], "us");
  assert.deepEqual(selected, { crypto: [], equity: [] });
});

test("materiality uses the larger endpoint OI so a complete unwind is not discarded", () => {
  const unwind = oiItem("UNWIND", "majors", 100_000, 0, {
    priorMark: 100,
    currentMark: 100,
    volume: 100_000_000,
  });
  const selected = selectMarketOpenOiItems([unwind], "us");
  assert.deepEqual(selected.crypto.map((item) => item.symbol), ["UNWIND"]);
});

test("formats an HTML-safe compact briefing with both universes and required context", () => {
  const crypto = oiItem("<BTC&>", "majors", 10_000, 10_200, {
    priorMark: 100,
    currentMark: 102,
    volume: 100_000_000,
  });
  crypto.smartFlowDeltaUsd = 750_000;
  crypto.smartFlowAlignment = "aligned";
  const equity = oiItem("SMSN", "stocks", 1_000, 950, {
    priorMark: 1_000,
    currentMark: 1_020,
    volume: 20_000_000,
  });

  const body = formatMarketOpenOiTelegram({
    region: "asia",
    sessionLabel: "Asia / Tokyo",
    localDate: "2026-07-27",
    reportAt: Date.parse("2026-07-26T23:30:00.000Z"),
    openAt: Date.parse("2026-07-27T00:00:00.000Z"),
    generatedAt: Date.parse("2026-07-26T23:31:00.000Z"),
    lookbackMs: 4 * 60 * 60_000,
    selection: { crypto: [crypto], equity: [equity] },
  });

  assert.ok(body);
  assert.match(body, /ASIA \/ TOKYO/);
  assert.match(body, /4H POSITIONING/);
  assert.match(body, /CRYPTO/);
  assert.match(body, /EQUITY PERPS/);
  assert.match(body, /OI qty/);
  assert.match(body, /total OI/);
  assert.match(body, /Px/);
  assert.match(body, /fund/);
  assert.match(body, /smart/);
  assert.match(body, /1\. <b>&lt;BTC&amp;&gt;<\/b>/);
  assert.match(body, /&lt;BTC&amp;&gt;/);
  assert.doesNotMatch(body, /<BTC&>/);
  assert.ok(body.length < 4_096);
});

test("suppresses a briefing with fewer than two valid items", () => {
  const only = oiItem("BTC", "majors", 1_000, 1_100);
  assert.equal(formatMarketOpenOiTelegram({
    region: "us",
    sessionLabel: "US / New York",
    localDate: "2026-07-27",
    reportAt: 1,
    openAt: 2,
    generatedAt: 1,
    lookbackMs: 4 * 60 * 60_000,
    selection: { crypto: [only], equity: [] },
  }), null);
});

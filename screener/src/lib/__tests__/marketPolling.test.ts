import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createLatestRequestGate,
  parseMarketPayload,
} from "@/lib/marketPolling";
import type { AssetData } from "@/lib/types";

function asset(): AssetData {
  return {
    symbol: "BTC",
    name: "Bitcoin",
    sector: "majors",
    sectorColor: "#fff",
    price: 65_000,
    change1h: null,
    change4h: null,
    change24h: 1,
    change7d: null,
    volume24h: 1_000_000,
    fundingRate: null,
    openInterest: null,
    markPrice: null,
    oraclePrice: null,
    source: "coingecko",
    oiUsd: null,
    oiChange24hUsd: null,
    oiChange24hPct: null,
    oiChange7dUsd: null,
    oiChange7dPct: null,
    fundingAvg24h: null,
    volOiRatio: null,
  };
}

test("market payload validation rejects successful non-array responses", () => {
  assert.throws(() => parseMarketPayload(null), /Invalid market response/);
  assert.throws(() => parseMarketPayload({ error: "unexpected" }), /Invalid market response/);
  assert.throws(() => parseMarketPayload("not-an-array"), /Invalid market response/);
  assert.deepEqual(parseMarketPayload([asset()]), [asset()]);
});

test("market payload validation rejects malformed array members", () => {
  const validAsset = asset();

  for (const invalid of [
    null,
    {},
    { ...validAsset, symbol: 7 },
    { ...validAsset, price: Number.NaN },
    { ...validAsset, oiUsd: Number.POSITIVE_INFINITY },
    { ...validAsset, source: "unknown" },
  ]) {
    assert.throws(
      () => parseMarketPayload([invalid]),
      /invalid market response/i,
    );
  }
});

test("latest-request gate rejects stale and post-unmount commits", () => {
  const gate = createLatestRequestGate();
  const first = gate.start();
  assert.equal(gate.isCurrent(first), true);

  const second = gate.start();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.close();
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.isCurrent(gate.start()), false);
});

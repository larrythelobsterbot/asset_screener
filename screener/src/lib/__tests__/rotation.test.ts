import assert from "node:assert/strict";
import test from "node:test";
import {
  ROTATION_WINDOWS,
  buildRotationMetric,
  compareRotationRows,
  estimateCandleVolume,
  rotationStateTransition,
  type RotationRow,
  type RotationSnapshotPoint,
} from "../rotation";

test("rotation uses paired snapshots for every requested horizon", () => {
  assert.deepEqual(ROTATION_WINDOWS, ["1h", "8h", "24h", "48h", "7d"]);
  const current: RotationSnapshotPoint = { ts: 10_000_000, mark: 120, oi: 12, funding: 0.0001 };
  const prior: RotationSnapshotPoint = { ts: 6_400_000, mark: 100, oi: 10, funding: 0.0002 };
  const metric = buildRotationMetric("1h", current, prior, "SPX", 20_000);
  assert.equal(metric.status, "observed");
  assert.equal(metric.currentTs, current.ts);
  assert.equal(metric.priorTs, prior.ts);
  assert.equal(metric.pricePct, 20);
  assert.equal(metric.oiCoinPct, 20);
  // SPX's real display scale is 20,000: (12 - 10) * (100 / 20,000).
  assert.equal(metric.quantityEffectUsd, 0.01);
  assert.equal(metric.oiUsdDelta, 12 * (120 / 20_000) - 10 * (100 / 20_000));
});

test("missing history stays unavailable rather than becoming a flat change", () => {
  const current: RotationSnapshotPoint = { ts: 1_000_000, mark: 100, oi: 5, funding: null };
  const metric = buildRotationMetric("8h", current, null, "BTC", 1);
  assert.equal(metric.status, "unavailable");
  assert.equal(metric.pricePct, null);
  assert.equal(metric.oiCoinPct, null);
  assert.equal(metric.quantityEffectUsd, null);
  assert.equal(metric.currentTs, current.ts);
  assert.equal(metric.priorTs, null);
});

test("zero current OI is real evidence, while zero prior OI has no percent denominator", () => {
  const current: RotationSnapshotPoint = { ts: 86_401_000, mark: 90, oi: 0, funding: 0 };
  const prior: RotationSnapshotPoint = { ts: 1_000, mark: 100, oi: 4, funding: 0 };
  const observed = buildRotationMetric("24h", current, prior, "BTC", 1);
  assert.equal(observed.oiCoinPct, -100);
  assert.equal(observed.quantityEffectUsd, -400);
  assert.equal(observed.oiStatus, "observed");

  const zeroPrior = buildRotationMetric(
    "24h",
    current,
    { ...prior, oi: 0 },
    "BTC",
    1,
  );
  assert.equal(zeroPrior.priceStatus, "observed");
  assert.equal(zeroPrior.oiCoinPct, null);
  assert.equal(zeroPrior.quantityEffectUsd, 0);
  assert.equal(zeroPrior.oiStatus, "unavailable");
});

test("candle turnover requires complete contiguous one-hour bars and is an estimate", () => {
  const bars = [
    { t: 0, open: 10, close: 12, volumeBase: 2 },
    { t: 3_600_000, open: 12, close: 11, volumeBase: 3 },
  ];
  const result = estimateCandleVolume(bars, 0, 7_200_000);
  assert.equal(result.status, "estimated");
  assert.equal(result.coverage, "complete");
  assert.equal(result.bars, 2);
  assert.equal(result.notionalUsdEstimate, 2 * 11 + 3 * 11.5);
  assert.match(result.provenance, /base volume.*raw candle price/i);

  const gap = estimateCandleVolume([bars[0], { ...bars[1], t: 7_200_000 }], 0, 10_800_000);
  assert.equal(gap.status, "unavailable");
  assert.equal(gap.coverage, "gapped");
});

test("invalid prices, timestamps, and arithmetic overflow fail closed", () => {
  const current: RotationSnapshotPoint = { ts: 3_601_000, mark: Number.MAX_VALUE, oi: 1, funding: 0 };
  const prior: RotationSnapshotPoint = { ts: 1_000, mark: Number.MIN_VALUE, oi: 1, funding: 0 };
  const overflow = buildRotationMetric("1h", current, prior, "BTC", 1);
  assert.equal(overflow.pricePct, null);
  assert.equal(overflow.priceStatus, "unavailable");

  const unpaired = buildRotationMetric(
    "1h",
    { ...current, mark: 100, ts: 20_000_000 },
    { ...prior, mark: 90 },
    "BTC",
  );
  assert.equal(unpaired.status, "unavailable");
  assert.equal(unpaired.pricePct, null);

  const invalidCandle = estimateCandleVolume(
    [{ t: 0, open: 0, close: 10, volumeBase: 1 }, { t: 3_600_000, open: -1, close: 10, volumeBase: 1 }],
    0,
    7_200_000,
  );
  assert.equal(invalidCandle.status, "unavailable");
});

test("unavailable values sort last and default rotation ordering is 8h quantity change", () => {
  const row = (symbol: string, quantityEffectUsd: number | null): RotationRow => ({
    symbol,
    name: symbol,
    contract: { kind: "native", dex: null, wireCoin: symbol, historyKey: symbol },
    current: { ts: 1, mark: 1, oi: 1, funding: 0 },
    volume24h: 1,
    windows: {
      "1h": buildRotationMetric("1h", null, null, symbol, 1),
      "8h": { ...buildRotationMetric("8h", null, null, symbol, 1), quantityEffectUsd },
      "24h": buildRotationMetric("24h", null, null, symbol, 1),
      "48h": buildRotationMetric("48h", null, null, symbol, 1),
      "7d": buildRotationMetric("7d", null, null, symbol, 1),
    },
  });
  const rows = [row("NULL", null), row("SMALL", 2), row("LARGE", 10)];
  rows.sort((a, b) => compareRotationRows(a, b, { field: "quantityEffectUsd", window: "8h" }));
  assert.deepEqual(rows.map((item) => item.symbol), ["LARGE", "SMALL", "NULL"]);
});

test("every metric and window supports increasing/decreasing order with nulls last", () => {
  const fields = ["pricePct", "oiCoinPct", "quantityEffectUsd"] as const;
  const current = { ts: 10_000, mark: 120, oi: 12, funding: 0 };
  const prior = { ts: 9_000, mark: 100, oi: 10, funding: 0 };
  for (const window of ROTATION_WINDOWS) {
    for (const field of fields) {
      const make = (symbol: string, value: number | null): RotationRow => ({
        symbol,
        name: symbol,
        contract: { kind: "native", dex: null, wireCoin: symbol, historyKey: symbol },
        current,
        volume24h: 1,
        windows: Object.fromEntries(ROTATION_WINDOWS.map((candidate) => [
          candidate,
          { ...buildRotationMetric(candidate, current, prior, symbol, 1), [field]: candidate === window ? value : null },
        ])) as RotationRow["windows"],
      });
      const descending = [make("NULL", null), make("LOW", 1), make("HIGH", 3)];
      descending.sort((a, b) => compareRotationRows(a, b, { field, window, direction: "desc" }));
      assert.deepEqual(descending.map((row) => row.symbol), ["HIGH", "LOW", "NULL"]);
      const ascending = [make("NULL", null), make("LOW", 1), make("HIGH", 3)];
      ascending.sort((a, b) => compareRotationRows(a, b, { field, window, direction: "asc" }));
      assert.deepEqual(ascending.map((row) => row.symbol), ["LOW", "HIGH", "NULL"]);
    }
  }
});

test("state annotations stay descriptive and do not turn into a direction", () => {
  const metric = buildRotationMetric(
    "8h",
    { ts: 28_800_001, mark: 110, oi: 12, funding: 0 },
    { ts: 1, mark: 100, oi: 10, funding: 0 },
    "BTC",
  );
  assert.deepEqual(rotationStateTransition(metric), { price: "up", oi: "up" });
  assert.equal("LONG" in rotationStateTransition(metric), false);
});

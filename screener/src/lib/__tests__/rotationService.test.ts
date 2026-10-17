import assert from "node:assert/strict";
import test from "node:test";
import { buildRotationPayload, rotationPointFromContext } from "../rotationService";
import { isRotationPayload, rotationWindowMs, ROTATION_WINDOWS, type RotationMarketContract } from "../rotation";

test("rotation service builds one bounded snapshot read per horizon and preserves metadata provenance", () => {
  const contract: RotationMarketContract = { kind: "hip3", dex: "xyz", wireCoin: "xyz:TSLA", historyKey: "TSLA" };
  const calls: Array<{ target: number; symbols: string[] }> = [];
  const now = 7 * 86_400_000 + 3_600_000;
  const payload = buildRotationPayload({
    now,
    assets: [{
      symbol: "TSLA",
      name: "Tesla",
      contract,
      current: { ts: now, mark: 220, oi: 10, funding: 0.0001 },
      volume24h: 1_000_000,
    }],
    historicalSnapshot: (target, _tolerance, symbols) => {
      calls.push({ target, symbols });
      return new Map([["TSLA", { ts: target, mark: 200, oi: 8, funding: 0.0002, volume: 1 }]]);
    },
    candles: () => new Map(),
  });
  assert.deepEqual(calls.map((call) => call.symbols), ROTATION_WINDOWS.map(() => ["TSLA"]));
  assert.equal(payload.rows[0].contract.wireCoin, "xyz:TSLA");
  assert.equal(payload.metadata.historyIdentity, "legacy-symbol");
  assert.equal(payload.rows[0].windows["8h"].quantityEffectUsd, 2 * 200);
  assert.equal(payload.rows[0].windows["8h"].volume.status, "unavailable");
  assert.equal(isRotationPayload(payload), true);

  const missingWindow = structuredClone(payload) as typeof payload;
  delete (missingWindow.rows[0].windows as Partial<typeof missingWindow.rows[0]["windows"]>)["24h"];
  assert.equal(isRotationPayload(missingWindow), false);

  const nanMetric = structuredClone(payload) as typeof payload;
  nanMetric.rows[0].windows["1h"].pricePct = Number.NaN;
  assert.equal(isRotationPayload(nanMetric), false);

  const collision = structuredClone(payload) as typeof payload;
  collision.rows.push(structuredClone(collision.rows[0]));
  assert.equal(isRotationPayload(collision), false);

  const wrongSymbol = structuredClone(payload) as typeof payload;
  wrongSymbol.rows[0].symbol = "OTHER";
  assert.equal(isRotationPayload(wrongSymbol), false);

  const mismatchedStatus = structuredClone(payload) as typeof payload;
  mismatchedStatus.rows[0].windows["1h"].pricePct = null;
  assert.equal(isRotationPayload(mismatchedStatus), false);

  const futureCurrent = structuredClone(payload) as typeof payload;
  futureCurrent.rows[0].current.ts = futureCurrent.generatedAt + 1;
  assert.equal(isRotationPayload(futureCurrent), false);

  const wrongMetricTimestamp = structuredClone(payload) as typeof payload;
  wrongMetricTimestamp.rows[0].windows["1h"].currentTs = payload.rows[0].current.ts - 1;
  assert.equal(isRotationPayload(wrongMetricTimestamp), false);

  const falselyFresh = structuredClone(payload) as typeof payload;
  falselyFresh.metadata.currentSourceAgeMs = falselyFresh.metadata.currentMaxAgeMs + 1;
  assert.equal(isRotationPayload(falselyFresh), false);
});

test("source scalar parsing keeps missing optional fields null and rejects scaled overflow", () => {
  assert.deepEqual(
    rotationPointFromContext({ markPx: "100", openInterest: "", funding: "" }, 1_000, 1),
    { ts: 1_000, mark: 100, oi: null, funding: null },
  );
  assert.deepEqual(
    rotationPointFromContext({ markPx: "100", openInterest: "0", funding: "0" }, 1_000, 1),
    { ts: 1_000, mark: 100, oi: 0, funding: 0 },
  );
  assert.equal(rotationPointFromContext({ markPx: "100", openInterest: "true", funding: "false" }, 1_000, 1)?.oi, null);
  assert.equal(rotationPointFromContext({ markPx: "1e308", openInterest: "1", funding: "0" }, 1_000, 20_000), null);
});

test("historical targets follow each asset source timestamp instead of one global anchor", () => {
  const now = 10_000_000;
  const calls: Array<{ target: number; symbols: string[] }> = [];
  buildRotationPayload({
    now,
    assets: [
      { symbol: "A", name: "A", contract: { kind: "native", dex: null, wireCoin: "A", historyKey: "A" }, current: { ts: now, mark: 10, oi: 1, funding: 0 }, volume24h: 1 },
      { symbol: "B", name: "B", contract: { kind: "native", dex: null, wireCoin: "B", historyKey: "B" }, current: { ts: now - 5_000, mark: 20, oi: 2, funding: 0 }, volume24h: 1 },
    ],
    historicalSnapshot: (target, _tolerance, symbols) => {
      calls.push({ target, symbols });
      return new Map(symbols.map((symbol) => [symbol, { ts: target, mark: 9, oi: 1, funding: 0, volume: 1 }]));
    },
    candles: () => new Map(),
  });
  const aOneHour = calls.find((call) => call.symbols.length === 1 && call.symbols[0] === "A");
  const bOneHour = calls.find((call) => call.symbols.length === 1 && call.symbols[0] === "B");
  assert.equal(aOneHour?.target, now - rotationWindowMs("1h"));
  assert.equal(bOneHour?.target, now - 5_000 - rotationWindowMs("1h"));
});

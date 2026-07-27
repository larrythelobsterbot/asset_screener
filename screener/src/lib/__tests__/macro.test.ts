import { test } from "node:test";
import assert from "node:assert/strict";
import { macroDataFromFredCsv, mergeMacroData, parseFredCsv } from "../macro";

const CSV = `observation_date,VIXCLS
2026-07-14,16.50
2026-07-15,.
2026-07-16,16.73
2026-07-17,18.77
`;

test("parseFredCsv keeps valid observations and skips missing values", () => {
  assert.deepEqual(parseFredCsv(CSV), [
    { date: "2026-07-14", value: 16.5 },
    { date: "2026-07-16", value: 16.73 },
    { date: "2026-07-17", value: 18.77 },
  ]);
});

test("macroDataFromFredCsv uses the latest two valid observations", () => {
  const point = macroDataFromFredCsv(CSV, "VIX", "Volatility");
  assert.equal(point.symbol, "VIX");
  assert.equal(point.value, 18.77);
  assert.ok(Math.abs((point.change ?? 0) - ((18.77 - 16.73) / 16.73) * 100) < 1e-10);
  assert.equal(point.source, "delayed");
  assert.equal(point.asOf, Date.parse("2026-07-17T00:00:00Z"));
});

test("macroDataFromFredCsv returns a null point when the feed has no values", () => {
  assert.deepEqual(macroDataFromFredCsv("observation_date,DGS10\n2026-07-17,.\n", "US10Y", "US 10Y"), {
    symbol: "US10Y",
    label: "US 10Y",
    value: null,
    change: null,
    source: "delayed",
    asOf: null,
  });
});

test("mergeMacroData preserves the last good point and marks degraded inputs stale", () => {
  const previous = [macroDataFromFredCsv(CSV, "VIX", "Volatility")];
  const current = [{
    symbol: "VIX",
    label: "Volatility",
    value: null,
    change: null,
    source: "delayed" as const,
    asOf: null,
  }];
  const merged = mergeMacroData(current, previous);
  assert.equal(merged.degraded, true);
  assert.equal(merged.data[0].value, 18.77);
  assert.equal(merged.data[0].asOf, Date.parse("2026-07-17T00:00:00Z"));
  assert.equal(merged.data[0].stale, true);
});

test("mergeMacroData leaves successful points fresh", () => {
  const current = [macroDataFromFredCsv(CSV, "VIX", "Volatility")];
  const merged = mergeMacroData(current, []);
  assert.equal(merged.degraded, false);
  assert.equal(merged.data[0].stale, false);
});

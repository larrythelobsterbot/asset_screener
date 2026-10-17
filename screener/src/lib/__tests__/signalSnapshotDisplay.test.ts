import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ageSignalSnapshot, parseSignalSnapshotResponse, signalSnapshotStatusText } from "@/lib/signalSnapshotDisplay";
import type { Signal } from "@/lib/signals";

const NOW = 1_800_000_000_000;
const signal: Signal = { symbol: "BTC", type: "breakout_up", family: "structure", direction: "bullish", value: 1, label: "Breakout", firedAt: NOW - 1_000, timeframe: "4h" };
function headers(stale: string | null, generated: string | null): Record<string, string | null> { return { "X-Data-Stale": stale, "X-Data-Generated-At": generated }; }
test("snapshot display preserves parser rows and reports malformed members", () => {
  const read = parseSignalSnapshotResponse([signal, { nope: true }], headers("false", String(NOW - 1_000)), NOW);
  assert.deepEqual(read.signals, [signal]);
  assert.equal(read.malformedRows, 1);
  assert.equal(ageSignalSnapshot(read, NOW).status, "partial");
  assert.equal(ageSignalSnapshot({ ...read, signals: [] }, NOW).status, "partial");
  assert.match(signalSnapshotStatusText(ageSignalSnapshot(read, NOW)), /malformed row omitted/);
  assert.match(signalSnapshotStatusText(ageSignalSnapshot({ ...read, signals: [], malformedRows: 0 }, NOW)), /zero cached signals/);
});
test("missing, malformed, future, stale, repeated, and failed metadata are conservative", () => {
  const missing = parseSignalSnapshotResponse([signal], headers(null, null), NOW);
  assert.equal(ageSignalSnapshot(missing, NOW).status, "unknown");
  const malformed = parseSignalSnapshotResponse([signal], headers("maybe", "nope"), NOW);
  assert.equal(ageSignalSnapshot(malformed, NOW).status, "unknown");
  const future = parseSignalSnapshotResponse([signal], headers("false", String(NOW + 1)), NOW);
  assert.equal(ageSignalSnapshot(future, NOW).status, "unknown");
  assert.equal(ageSignalSnapshot({ ...missing, generatedAt: NOW + 1 }, NOW).status, "unknown");
  assert.equal(ageSignalSnapshot({ ...missing, generatedAt: NOW - 1 }, Number.NaN).status, "unknown");
  assert.equal(ageSignalSnapshot({ ...missing, generatedAt: NOW - 1 }, NOW - 2).status, "unknown");
  assert.equal(ageSignalSnapshot({ ...missing, generatedAt: NOW - 1 }, -1).status, "unknown");
  assert.equal(ageSignalSnapshot({ ...missing, generatedAt: NOW + 1 }, NOW + 2).status, "unknown");
  const stale = parseSignalSnapshotResponse([signal], headers("true", String(NOW - 1_000)), NOW);
  assert.equal(ageSignalSnapshot(stale, NOW).status, "stale");
  assert.equal(ageSignalSnapshot(stale, NOW + 55_000).status, "stale");
  assert.equal(ageSignalSnapshot(stale, NOW, true).status, "unavailable");
  assert.equal(ageSignalSnapshot({ ...stale, malformedRows: 1 }, NOW).status, "stale");
  assert.doesNotMatch(signalSnapshotStatusText(ageSignalSnapshot({ ...stale, malformedRows: 1 }, NOW)), /No usable signal rows/);
});
test("all malformed and cold states never claim zero current cached signals", () => {
  const allMalformed = parseSignalSnapshotResponse([{ nope: true }], headers("false", String(NOW - 1_000)), NOW);
  assert.equal(allMalformed.signals.length, 0);
  assert.equal(allMalformed.malformedRows, 1);
  assert.match(signalSnapshotStatusText(ageSignalSnapshot(allMalformed, NOW)), /No usable signal rows/);
  assert.doesNotMatch(signalSnapshotStatusText(ageSignalSnapshot(allMalformed, NOW)), /zero cached signals/);
  assert.match(signalSnapshotStatusText(ageSignalSnapshot({ signals: [], generatedAt: null, stale: null, malformedRows: 0 }, NOW)), /availability unknown/);
});

test("rejected future metadata cannot recover merely because browser time catches up", () => {
  const future = parseSignalSnapshotResponse([signal], headers("false", String(NOW + 10_000)), NOW);
  assert.equal(ageSignalSnapshot(future, NOW + 20_000).status, "unknown");
  assert.equal(ageSignalSnapshot(future, NOW).ageMs, null);
});

test("held snapshot evidence uses conservative receipt clocks without renewing source time", () => {
  const read = parseSignalSnapshotResponse([signal], headers("false", String(NOW - 10_000)), NOW, 1000);
  assert.equal(ageSignalSnapshot(read, NOW - 1, false, 1001).status, "unknown");
  assert.equal(ageSignalSnapshot(read, NOW, false, 46_000).status, "stale");
  assert.equal(ageSignalSnapshot(read, NOW + 50_000, false, 1001).status, "stale");
  assert.equal(ageSignalSnapshot(read, NOW + 1, false, 999).status, "unknown");
  const repeated = parseSignalSnapshotResponse([signal], headers("false", String(NOW - 10_000)), NOW + 40_000, 41_000);
  assert.equal(ageSignalSnapshot(repeated, NOW + 45_000, false, 46_000).status, "stale");
});

test("partial copy acknowledges retained usable rows and never describes them as absent", () => {
  const read = parseSignalSnapshotResponse([signal, {}], headers("false", String(NOW - 1000)), NOW);
  const text = signalSnapshotStatusText(ageSignalSnapshot(read, NOW));
  assert.match(text, /partial/i);
  assert.match(text, /1 malformed row omitted/i);
  assert.doesNotMatch(text, /No usable signal rows/);
});

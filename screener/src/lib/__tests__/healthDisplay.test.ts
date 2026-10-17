import { strict as assert } from "node:assert";
import { test } from "node:test";
import { acceptHealthSample, getHealthView, parseHealthResponse, type HealthReceipt } from "@/lib/healthDisplay";

const base = { status: "ok", now: 1_800_000_000_000, hlWs: { connected: true, symbolCount: 10, msSinceLastMessage: 100 }, treeWs: { connected: true, authed: true, isSub: true }, snapshotAgeMs: 1_000, feedAgeMs: 2_000 };
test("health parser rejects coercion, malformed late fields, and accepts unknown extras", () => {
  assert.ok(parseHealthResponse({ ...base, extra: "ignored" }));
  for (const bad of [{ ...base, now: null }, { ...base, hlWs: { ...base.hlWs, symbolCount: 1.2 } }, { ...base, snapshotAgeMs: -1 }, { ...base, hlWs: { ...base.hlWs, msSinceLastMessage: -1 } as never, treeWs: { ...base.treeWs, isSub: "yes" } }]) assert.equal(parseHealthResponse(bad), null);
  assert.equal(parseHealthResponse({ ...base, hlWs: { ...base.hlWs, msSinceLastMessage: -1 } })?.hlWs.msSinceLastMessage, null);
});
test("health display distinguishes cold, error, degraded, source age, and expiry", () => {
  assert.equal(getHealthView(null, 0).availability, "unknown");
  const sample = parseHealthResponse(base)!;
  const receipt: HealthReceipt = { sample, receivedAt: 1000 };
  assert.equal(getHealthView(receipt, 1000).availability, "usable");
  assert.equal(getHealthView(receipt, 1000, true).availability, "error");
  assert.equal(getHealthView(receipt, 45_999).availability, "usable");
  assert.equal(getHealthView(receipt, 46_000).availability, "expired");
  assert.equal(getHealthView({ sample: { ...sample, status: "degraded" }, receivedAt: 1000 }, 1000).prices, "warn");
  assert.equal(getHealthView({ sample: { ...sample, hlWs: { ...sample.hlWs, msSinceLastMessage: null } }, receivedAt: 1000 }, 1000).prices, "warn");
});
test("WS health uses the exact incumbent connected age rule", () => {
  for (const [age, expected] of [[9_999, "ok"], [10_000, "warn"], [10_001, "warn"]] as const) {
    const current = parseHealthResponse({ ...base, hlWs: { ...base.hlWs, msSinceLastMessage: age } })!;
    assert.equal(getHealthView({ sample: current, receivedAt: 1000 }, 1000).prices, expected);
  }
  const disconnected = parseHealthResponse({ ...base, hlWs: { ...base.hlWs, connected: false, msSinceLastMessage: 0 } })!;
  assert.equal(getHealthView({ sample: disconnected, receivedAt: 1000 }, 1000).prices, "warn");
});
test("health ages project from both receipt clocks and expire conservatively", () => {
  const parsed = parseHealthResponse(base)!;
  const receipt: HealthReceipt = { sample: parsed, receivedAt: 1_000, receivedWallAt: 10_000 };
  const projected = getHealthView(receipt, 1_100, false, 70_000);
  assert.equal(projected.receiptAgeMs, 60_000);
  assert.equal(projected.pricesAgeMs, 60_100);
  assert.equal(projected.availability, "expired");
  assert.equal(getHealthView(receipt, 1_100, false, 9_000).availability, "expired");
  assert.equal(getHealthView(receipt, 1_100, false, Number.NaN).availability, "expired");
  assert.equal(getHealthView(receipt, Number.NaN, false, 70_000).availability, "expired");
});
test("equal and regressed server generations cannot renew receipt evidence", () => {
  const sample = parseHealthResponse(base)!;
  const first = acceptHealthSample(null, sample, 100)!;
  assert.ok(first);
  assert.equal(acceptHealthSample(first, sample, 200), null);
  assert.equal(acceptHealthSample(first, { ...sample, now: sample.now - 1 }, 200), null);
  assert.equal(acceptHealthSample(first, { ...sample, now: sample.now + 1 }, 200)?.receivedAt, 200);
  assert.equal(acceptHealthSample(null, sample, 200, Number.NaN), null);
});

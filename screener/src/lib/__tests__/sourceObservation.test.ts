import "./db-test-setup";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { cache } from "../cache";
import { loadObservedSource, sourceAgeMs } from "../sourceObservation";
import { GET } from "../../app/api/derivs/route";

test("returned data retains its own timestamp across a refresh race", async () => {
  let now = 1_800_000_000_000;
  mock.method(Date, "now", () => now);
  try {
    const old = { version: "old" }, fresh = { version: "new" };
    cache.set("test:source-race", old, 30_000);
    const oldAt = now;
    now += 90_000;
    const source = await loadObservedSource("test:source-race", async () => {
      cache.set("test:source-race", fresh, 30_000);
      return old;
    }, 600_000);
    assert.equal(source.data, old);
    assert.equal(source.observedAt, oldAt);
    assert.equal(source.stale, true);
    assert.equal(cache.getInfo("test:source-race")?.createdAt, now);
  } finally { mock.restoreAll(); }
});

test("source loader fails closed on unknown, future, or expired observations", async () => {
  let now = 1_800_000_000_000;
  mock.method(Date, "now", () => now);
  try {
    await assert.rejects(loadObservedSource("test:unknown", async () => ({}), 600_000));
    const value = {};
    cache.set("test:future", value, 30_000);
    now -= 1000;
    await assert.rejects(loadObservedSource("test:future", async () => value, 600_000));
    now += 602_000;
    await assert.rejects(loadObservedSource("test:future", async () => value, 600_000));
    assert.equal(sourceAgeMs(now + 1, now), null);
  } finally { mock.restoreAll(); }
});

test("derivs response rejects future source age at the actual route boundary", async () => {
  const now = Date.now();
  cache.set("api:derivs:v2", {
    items: [], metadata: { generatedAt: now, sourceObservedAt: now + 60_000, sourceAgeMs: 0, ageMs: 0,
      status: "fresh", stale: false, partial: false, failedSources: [], staleSources: [] },
  }, 20_000);
  const response = await GET();
  const payload = await response.json();
  assert.equal(payload.metadata.sourceAgeMs, null);
  assert.equal(payload.metadata.stale, true);
  assert.equal(payload.metadata.partial, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedRemainingTtl, cache } from "../cache";

test("cache exposes value age and freshness metadata", () => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const key = `cache-info-${Math.random()}`;
    cache.set(key, { ok: true }, 1_000);
    now += 250;
    assert.deepEqual(cache.getInfo<{ ok: boolean }>(key), {
      data: { ok: true },
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_001_000,
      ageMs: 250,
      fresh: true,
    });
    now += 1_000;
    assert.equal(cache.getInfo<{ ok: boolean }>(key)?.fresh, false);
  } finally {
    Date.now = originalNow;
  }
});

test("cache refuses stale data older than the caller's maximum age", () => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    const key = `cache-stale-${Math.random()}`;
    cache.set(key, "value", 100);
    now += 500;
    assert.equal(cache.getStaleWithin<string>(key, 500), "value");
    now += 1;
    assert.equal(cache.getStaleWithin<string>(key, 500), null);
  } finally {
    Date.now = originalNow;
  }
});

test("boundedRemainingTtl never returns an already-expired TTL", () => {
  assert.equal(boundedRemainingTtl(60_000, 20_000), 40_000);
  assert.equal(boundedRemainingTtl(60_000, 90_000), 1_000);
  assert.equal(boundedRemainingTtl(30_000, 30_000, 2_500), 2_500);
});

test("getWithRefresh coalesces concurrent cold requests", async () => {
  const key = `cache-singleflight-${Math.random()}`;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetcher = async () => {
    calls++;
    await gate;
    return "signals";
  };

  const first = cache.getWithRefresh(key, fetcher, 30_000);
  const second = cache.getWithRefresh(key, fetcher, 30_000);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["signals", "signals"]);
});

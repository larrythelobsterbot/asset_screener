import { strict as assert } from "node:assert";
import { test } from "node:test";

import { GET } from "@/app/api/signals/snapshot/route";
import { cache } from "@/lib/cache";

const SIGNAL_CACHE_KEY = "api:signals";

test("signal snapshot route serves cached data without refreshing the scan", async () => {
  const cached = [{ symbol: "BTC", label: "cached-only" }];
  cache.set(SIGNAL_CACHE_KEY, cached, 55_000);
  const before = cache.getInfo(SIGNAL_CACHE_KEY);

  const response = await GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), cached);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Data-Stale"), "false");
  assert.equal(response.headers.get("X-Data-Generated-At"), String(before?.createdAt));
  const after = cache.getInfo(SIGNAL_CACHE_KEY);
  assert.deepEqual(after?.data, before?.data);
  assert.equal(after?.createdAt, before?.createdAt);
  assert.equal(after?.expiresAt, before?.expiresAt);
});

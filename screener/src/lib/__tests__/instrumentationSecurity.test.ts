import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveScreenerSelfOrigin } from "../../instrumentation";

test("self-ping origin accepts loopback only", () => {
  assert.equal(resolveScreenerSelfOrigin({}), "http://127.0.0.1:3003");
  assert.equal(
    resolveScreenerSelfOrigin({ SCREENER_SELF_ORIGIN: "http://localhost:4181" }),
    "http://localhost:4181",
  );
  assert.equal(
    resolveScreenerSelfOrigin({ SCREENER_SELF_ORIGIN: "https://[::1]:3443" }),
    "https://[::1]:3443",
  );
});

test("self-ping origin rejects remote, credentialed, and path-bearing URLs", () => {
  for (const origin of [
    "https://example.com",
    "http://100.64.0.1:3003",
    "http://user:pass@127.0.0.1:3003",
    "http://127.0.0.1:3003/proxy",
    "not-a-url",
  ]) {
    assert.throws(
      () => resolveScreenerSelfOrigin({ SCREENER_SELF_ORIGIN: origin }),
      /loopback HTTP\(S\) origin/,
      origin,
    );
  }
});

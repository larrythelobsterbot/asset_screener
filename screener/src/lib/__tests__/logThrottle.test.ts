import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldLogChangedOrExpired } from "../logThrottle";

test("shouldLogChangedOrExpired logs the first value and changed values", () => {
  assert.equal(shouldLogChangedOrExpired(null, "a", 0, 1_000, 60_000), true);
  assert.equal(shouldLogChangedOrExpired("a", "b", 1_000, 2_000, 60_000), true);
});

test("shouldLogChangedOrExpired suppresses repeats until the interval expires", () => {
  assert.equal(shouldLogChangedOrExpired("a", "a", 1_000, 60_999, 60_000), false);
  assert.equal(shouldLogChangedOrExpired("a", "a", 1_000, 61_000, 60_000), true);
});

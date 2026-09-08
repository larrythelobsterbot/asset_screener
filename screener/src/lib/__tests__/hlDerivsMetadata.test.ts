import { strict as assert } from "node:assert";
import { test } from "node:test";
import { oldestIncludedObservationAt } from "../hlDerivs";

test("source metadata uses the oldest included observation and fails closed on unknown age", () => {
  assert.equal(oldestIncludedObservationAt([1_700_000_000_000, 1_700_000_030_000, 1_700_000_010_000]), 1_700_000_000_000);
  assert.equal(oldestIncludedObservationAt([1_700_000_000_000, null]), null);
  assert.equal(oldestIncludedObservationAt([]), null);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  parseStoredStringSet,
  serializeStringSet,
} from "@/lib/stringSetStorage";

test("string-set persistence uses a validated versioned envelope", () => {
  const serialized = serializeStringSet(new Set(["BTC", "ETH"]));
  assert.deepEqual(JSON.parse(serialized), {
    version: 1,
    values: ["BTC", "ETH"],
  });
  assert.deepEqual([...parseStoredStringSet(serialized)], ["BTC", "ETH"]);
});

test("string-set persistence migrates safe legacy arrays", () => {
  assert.deepEqual(
    [...parseStoredStringSet(JSON.stringify(["BTC", 7, "", "ETH", "BTC"]))],
    ["BTC", "ETH"],
  );
});

test("string-set persistence rejects malformed and unknown envelopes", () => {
  for (const raw of [
    null,
    "not json",
    JSON.stringify({ version: 2, values: ["BTC"] }),
    JSON.stringify({ version: 1, values: "BTC" }),
    JSON.stringify({ version: 1, values: ["BTC", 7] }),
  ]) {
    assert.deepEqual([...parseStoredStringSet(raw)], []);
  }
});

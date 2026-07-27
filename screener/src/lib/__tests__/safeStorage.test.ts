import { strict as assert } from "node:assert";
import { test } from "node:test";

import { readStorage, writeStorage } from "@/lib/safeStorage";

function throwingStorage(): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem() {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem() {
      throw new DOMException("blocked", "QuotaExceededError");
    },
  };
}

test("storage reads fail closed when access or getItem throws", () => {
  assert.equal(readStorage(() => { throw new DOMException("blocked", "SecurityError"); }, "key"), null);
  assert.equal(readStorage(throwingStorage, "key"), null);
});

test("storage writes are best-effort when access or setItem throws", () => {
  assert.doesNotThrow(() => writeStorage(() => { throw new DOMException("blocked", "SecurityError"); }, "key", "value"));
  assert.doesNotThrow(() => writeStorage(throwingStorage, "key", "value"));

  const values = new Map<string, string>();
  const storage: Pick<Storage, "getItem" | "setItem"> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  writeStorage(() => storage, "key", "value");
  assert.equal(readStorage(() => storage, "key"), "value");
});

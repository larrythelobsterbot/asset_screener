import { strict as assert } from "node:assert";
import { test } from "node:test";
import { initialHealthPollState, recordHealthError, recordHealthSuccess } from "@/lib/healthPolling";

const sample = { status: "ok", now: 1_800_000_000_000, hlWs: { connected: true, symbolCount: 1, msSinceLastMessage: 0 }, treeWs: { connected: true, authed: true, isSub: null }, snapshotAgeMs: null, feedAgeMs: 0 };
test("poll state marks malformed/error unavailable and recovers only on newer valid sample", () => {
  const cold = recordHealthSuccess(initialHealthPollState, {}, 1);
  assert.equal(cold.receipt, null);
  assert.ok(cold.error);
  const loaded = recordHealthSuccess(cold, sample, 2);
  assert.ok(loaded.receipt);
  assert.equal(loaded.error, null);
  const failed = recordHealthError(loaded, new Error("offline"));
  assert.equal(failed.error, "offline");
  const equal = recordHealthSuccess(failed, sample, 3);
  assert.equal(equal.error, "offline");
  const recovered = recordHealthSuccess(failed, { ...sample, now: sample.now + 1 }, 4);
  assert.equal(recovered.error, null);
});

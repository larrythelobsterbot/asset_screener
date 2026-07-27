import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ALERT_OUTCOME_CAPABILITY_GLOBAL,
  ALERT_OUTCOME_CAPABILITY_HEADER,
  isAuthorizedAlertOutcomeRequest,
} from "@/lib/alertOutcomeAuth";
import { POST } from "@/app/api/alert-outcomes/evaluate/route";

type CapabilityGlobal = typeof globalThis & Record<string, unknown>;

function setCapability(value: unknown): void {
  (globalThis as CapabilityGlobal)[ALERT_OUTCOME_CAPABILITY_GLOBAL] = value;
}

test("alert outcome evaluator rejects requests without the process capability", async () => {
  setCapability("test-capability");

  const missing = await POST(new Request("http://localhost/api/alert-outcomes/evaluate", {
    method: "POST",
  }));
  assert.equal(missing.status, 401);

  const wrong = await POST(new Request("http://localhost/api/alert-outcomes/evaluate", {
    method: "POST",
    headers: { [ALERT_OUTCOME_CAPABILITY_HEADER]: "wrong" },
  }));
  assert.equal(wrong.status, 401);
});

test("alert outcome evaluator recognizes only the exact process capability", () => {
  setCapability("test-capability");

  const valid = new Request("http://localhost/api/alert-outcomes/evaluate", {
    method: "POST",
    headers: { [ALERT_OUTCOME_CAPABILITY_HEADER]: "test-capability" },
  });
  assert.equal(isAuthorizedAlertOutcomeRequest(valid), true);

  setCapability(undefined);
  assert.equal(isAuthorizedAlertOutcomeRequest(valid), false);
});

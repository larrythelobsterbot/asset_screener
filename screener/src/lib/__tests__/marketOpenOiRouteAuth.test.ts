import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ALERT_OUTCOME_CAPABILITY_GLOBAL,
  ALERT_OUTCOME_CAPABILITY_HEADER,
} from "@/lib/alertOutcomeAuth";
import { POST } from "@/app/api/market-open-oi/run/route";

type CapabilityGlobal = typeof globalThis & Record<string, unknown>;

test("market-open OI runner rejects requests without the process capability", async () => {
  (globalThis as CapabilityGlobal)[ALERT_OUTCOME_CAPABILITY_GLOBAL] = "test-capability";

  const missing = await POST(new Request("http://localhost/api/market-open-oi/run", {
    method: "POST",
  }));
  assert.equal(missing.status, 401);

  const wrong = await POST(new Request("http://localhost/api/market-open-oi/run", {
    method: "POST",
    headers: { [ALERT_OUTCOME_CAPABILITY_HEADER]: "wrong" },
  }));
  assert.equal(wrong.status, 401);
});

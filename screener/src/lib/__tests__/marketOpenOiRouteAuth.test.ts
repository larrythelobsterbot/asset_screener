import "./db-test-setup";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ALERT_OUTCOME_CAPABILITY_GLOBAL,
  ALERT_OUTCOME_CAPABILITY_HEADER,
} from "@/lib/alertOutcomeAuth";
import { POST } from "@/app/api/market-open-oi/run/route";
import { GET } from "@/app/api/market-open-oi/route";

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

test("market-open OI report evidence is private and uses the capability-protected read path", async () => {
  (globalThis as CapabilityGlobal)[ALERT_OUTCOME_CAPABILITY_GLOBAL] = "test-capability";

  const missing = await GET(new Request("http://localhost/api/market-open-oi?limit=100"));
  assert.equal(missing.status, 404);

  const authorized = await GET(new Request("http://localhost/api/market-open-oi?limit=100", {
    headers: { [ALERT_OUTCOME_CAPABILITY_HEADER]: "test-capability" },
  }));
  assert.equal(authorized.status, 200);
  assert.match(authorized.headers.get("cache-control") ?? "", /private/);
  const body = await authorized.json() as { reports: unknown[]; summary: { total: number } };
  assert.deepEqual(body.reports, []);
  assert.equal(body.summary.total, 0);
});

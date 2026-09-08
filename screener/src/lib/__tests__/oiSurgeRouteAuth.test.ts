import "./db-test-setup";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  ALERT_OUTCOME_CAPABILITY_GLOBAL,
  ALERT_OUTCOME_CAPABILITY_HEADER,
} from "@/lib/alertOutcomeAuth";
import { GET } from "@/app/api/oi-surges/route";
import { POST } from "@/app/api/oi-surges/run/route";
import { reserveOiSurgeEvent } from "@/lib/db";

const capabilityGlobal = globalThis as typeof globalThis & Record<string, unknown>;

test("OI surge runner is process-capability protected", async () => {
  capabilityGlobal[ALERT_OUTCOME_CAPABILITY_GLOBAL] = "oi-test-capability";

  const missing = await POST(new Request("http://localhost/api/oi-surges/run", { method: "POST" }));
  assert.equal(missing.status, 401);

  const wrong = await POST(new Request("http://localhost/api/oi-surges/run", {
    method: "POST",
    headers: { [ALERT_OUTCOME_CAPABILITY_HEADER]: "wrong" },
  }));
  assert.equal(wrong.status, 401);

  const authorized = await POST(new Request("http://localhost/api/oi-surges/run", {
    method: "POST",
    headers: { [ALERT_OUTCOME_CAPABILITY_HEADER]: "oi-test-capability" },
  }));
  assert.equal(authorized.status, 200);
  const body = await authorized.json() as { accepted: boolean; report: { scan: { status: string } } | null };
  assert.equal(body.accepted, true);
  assert.equal(body.report?.scan.status, "warming");
});

test("OI surge read API is public, bounded, and exposes shadow summaries without raw evidence", async () => {
  const response = await GET(new Request("http://localhost/api/oi-surges?limit=999&hours=999"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /private/);
  const body = await response.json() as {
    policyVersion: string;
    mode: string;
    alertMode: string;
    summary: { total: number; high: number; extreme: number };
    events: unknown[];
    windowHours: number;
  };
  assert.equal(body.policyVersion, "oi-surge-shadow-v1");
  assert.equal(body.mode, "shadow");
  assert.equal(body.alertMode, "shadow");
  assert.deepEqual(body.summary, { total: 0, high: 0, extreme: 0 });
  assert.deepEqual(body.events, []);
  assert.equal(body.windowHours, 168, "public history window must be bounded to seven days");
  assert.equal(JSON.stringify(body).includes("evidence_json"), false);
});

test("OI surge symbol-filtered reads return a matching filtered summary", async () => {
  const now = Date.now() - 60_000;
  for (const [symbol, severity] of [["BTC", "extreme"], ["ETH", "high"]] as const) {
    reserveOiSurgeEvent({
      policy_version: "oi-surge-shadow-v1",
      source: "hyperliquid",
      symbol,
      sector: "majors",
      detected_at: now,
      severity,
      primary_horizon: "15m",
      quadrant: "expanding_up",
      entry_mark: symbol === "BTC" ? 120_000 : 4_000,
      entry_oi_usd: 100_000_000,
      oi_coins_change_pct: 12,
      oi_quantity_delta_usd: 12_000_000,
      price_change_pct: 1,
      volume_24h: 50_000_000,
      funding_hourly: 0.0001,
      horizons: ["15m"],
      lanes: ["relative"],
      evidence: { fixture: true },
      observed_at: now + 1_000,
    }, 4 * 60 * 60_000);
  }

  const response = await GET(new Request("http://localhost/api/oi-surges?symbol=btc&hours=24"));
  const body = await response.json() as {
    summary: { total: number; high: number; extreme: number };
    events: Array<{ symbol: string }>;
  };
  assert.deepEqual(body.events.map((event) => event.symbol), ["BTC"]);
  assert.deepEqual(body.summary, { total: 1, high: 0, extreme: 1 });
});

test("OI surge read API discloses the explicitly enabled pilot mode", async () => {
  const previous = process.env.OI_SURGE_ALERT_MODE;
  process.env.OI_SURGE_ALERT_MODE = "extreme-pilot";
  try {
    const response = await GET(new Request("http://localhost/api/oi-surges?hours=1"));
    const body = await response.json() as { mode: string; alertMode: string };
    assert.equal(body.mode, "shadow", "descriptive event tracking remains shadow evidence");
    assert.equal(body.alertMode, "extreme-pilot");
  } finally {
    if (previous === undefined) delete process.env.OI_SURGE_ALERT_MODE;
    else process.env.OI_SURGE_ALERT_MODE = previous;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeAlertPerformance,
  classifyEvidence,
  parsePerformanceWindowDays,
  type AlertPerformanceInput,
} from "../alertPerformance";

function alert(
  outcome: AlertPerformanceInput["outcome_status"],
  pnlR: number | null,
  opts: Partial<AlertPerformanceInput> = {},
): AlertPerformanceInput {
  return {
    delivery_status: "delivered",
    outcome_status: outcome,
    pnl_r: pnlR,
    conviction_label: "Strong Buy",
    families_json: JSON.stringify(["momentum"]),
    ...opts,
  };
}

test("summarizeAlertPerformance separates delivery and outcome states", () => {
  const summary = summarizeAlertPerformance([
    alert("target", 3),
    alert("stop", -1),
    alert("expired", 0.5),
    alert("ambiguous", null),
    alert("open", null),
    alert("untrackable", null),
    alert("untrackable", null, { delivery_status: "failed" }),
    alert("untrackable", null, { delivery_status: "failed", delivery_uncertain: true }),
    alert("untrackable", null, { delivery_status: "pending" }),
  ]);

  assert.deepEqual(summary.delivery, { attempts: 9, delivered: 6, failed: 1, unknown: 1, pending: 1 });
  assert.deepEqual(summary.outcomes, {
    open: 1,
    target: 1,
    stop: 1,
    expired: 1,
    ambiguous: 1,
    untrackable: 1,
  });
  assert.equal(summary.resolved, 4);
  assert.equal(summary.decisive, 2);
  assert.equal(summary.finiteROutcomes, 3);
  assert.equal(summary.decisiveTpSl, 2);
});

test("summarizeAlertPerformance computes honest win rates and expectancy", () => {
  const summary = summarizeAlertPerformance([
    alert("target", 3),
    alert("target", 3),
    alert("stop", -1),
    alert("expired", -0.5),
    alert("ambiguous", null),
  ]);

  assert.ok(Math.abs((summary.targetRateDecisivePct ?? 0) - 200 / 3) < 1e-9);
  assert.equal(summary.successRateAllResolvedPct, 40);
  assert.equal(summary.expectancyR, 1.125);
  assert.equal(summary.totalR, 4.5);
  assert.equal(summary.finiteROutcomes, 4);
  assert.equal(summary.decisiveTpSl, 3);
});

test("summarizeAlertPerformance exposes finite-R and decisive denominators per group", () => {
  const summary = summarizeAlertPerformance([
    alert("target", 3, { conviction_label: "Strong Buy" }),
    alert("stop", -1, { conviction_label: "Strong Buy" }),
    alert("expired", 0.5, { conviction_label: "Strong Buy" }),
    alert("ambiguous", null, { conviction_label: "Strong Buy" }),
  ]);

  const group = summary.byConviction[0];
  assert.equal(group.finiteROutcomes, 3);
  assert.equal(group.decisiveTpSl, 2);
});

test("truncated windows suppress verdicts and authoritative performance metrics", () => {
  const summary = summarizeAlertPerformance(
    Array.from({ length: 30 }, () => alert("target", 3)),
    { sampleTruncated: true },
  );

  assert.equal(summary.analysisSuppressed, true);
  assert.equal(summary.evidence.classification, "insufficient");
  assert.equal(summary.expectancyR, null);
  assert.equal(summary.targetRateDecisivePct, null);
  assert.equal(summary.byConviction[0]?.expectancyR, null);
  assert.equal(summary.byConviction[0]?.targetRateDecisivePct, null);
});

test("classifyEvidence waits for a useful sample and compares against 3R breakeven", () => {
  assert.equal(classifyEvidence(10, 20).classification, "insufficient");
  assert.equal(classifyEvidence(30, 30).classification, "promising");
  assert.equal(classifyEvidence(0, 30).classification, "weak");
  assert.equal(classifyEvidence(8, 30).classification, "inconclusive");
});

test("summarizeAlertPerformance builds conviction and family breakdowns safely", () => {
  const summary = summarizeAlertPerformance([
    alert("target", 3, { conviction_label: "Strong Buy", families_json: JSON.stringify(["momentum", "trend"]) }),
    alert("stop", -1, { conviction_label: "Strong Sell", families_json: JSON.stringify(["trend"]) }),
    alert("expired", 0.2, { conviction_label: null, families_json: "not-json" }),
  ]);

  assert.deepEqual(summary.byConviction.map((x) => x.key), ["Strong Buy", "Strong Sell", "Unknown"]);
  assert.deepEqual(summary.byFamily.map((x) => x.key), ["trend", "momentum"]);
  assert.equal(summary.byFamily.find((x) => x.key === "trend")?.attempts, 2);
});

test("performance window parsing rejects NaN and clamps the supported range", () => {
  assert.equal(parsePerformanceWindowDays(null), 90);
  assert.equal(parsePerformanceWindowDays("not-a-number"), 90);
  assert.equal(parsePerformanceWindowDays("0"), 1);
  assert.equal(parsePerformanceWindowDays("500"), 365);
  assert.equal(parsePerformanceWindowDays("30.9"), 30);
});

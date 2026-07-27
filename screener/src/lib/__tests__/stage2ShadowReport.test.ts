import "./db-test-setup";

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildStage2ShadowReport, type Stage2ShadowReportRow } from "../stage2ShadowReport";

const shadow = (combinedConservativePass: boolean) => JSON.stringify({
  policyVersion: "stage2-shadow-v1",
  gates: {
    opposingSignalVeto: { pass: combinedConservativePass },
    minimumIndependentFamilies: { pass: combinedConservativePass },
    fourHourDirectionalConfirmation: { pass: combinedConservativePass },
    fundingHeadwind: { pass: true },
    scoreAtLeast4: { pass: combinedConservativePass },
    scoreAtLeast4_5: { pass: false },
  },
  combinedConservativePass,
});

test("Stage 2 report separates candidate, linked-delivery, and counterfactual denominators", () => {
  const rows: Stage2ShadowReportRow[] = [
    {
      candidate_id: 1,
      candidate_strategy_version: "stage1-closed-bars-v2",
      shadow_policy_json: shadow(true),
      alert_id: 11,
      delivery_status: "delivered",
      live_outcome_status: "stop",
      live_pnl_r: -1,
      counterfactual_outcome_status: "stop",
      counterfactual_pnl_r: -1,
    },
    {
      candidate_id: 2,
      candidate_strategy_version: "stage1-closed-bars-v2",
      shadow_policy_json: shadow(false),
      alert_id: 12,
      delivery_status: "delivered",
      live_outcome_status: "target",
      live_pnl_r: 3,
      counterfactual_outcome_status: "target",
      counterfactual_pnl_r: 1.5,
    },
    {
      candidate_id: 3,
      candidate_strategy_version: "stage1-closed-bars-v2",
      shadow_policy_json: shadow(true),
      alert_id: null,
      delivery_status: null,
      live_outcome_status: null,
      live_pnl_r: null,
      counterfactual_outcome_status: null,
      counterfactual_pnl_r: null,
    },
  ];

  const report = buildStage2ShadowReport(rows);
  assert.equal(report.candidates.evaluated, 3);
  assert.equal(report.candidates.linkedDelivered, 2);
  assert.equal(report.candidates.combinedConservativePass, 2);
  assert.equal(report.gates.minimumIndependentFamilies.pass, 2);
  assert.equal(report.gates.minimumIndependentFamilies.linkedDeliveredPass, 1);
  assert.equal(report.gates.minimumIndependentFamilies.finiteCounterfactualOutcomePass, 1);
  assert.deepEqual(report.target1_5r.outcomes, {
    open: 0,
    target: 1,
    stop: 1,
    expired: 0,
    ambiguous: 0,
    untrackable: 0,
  });
  assert.equal(report.target1_5r.expectancyR, null);
  assert.equal(report.target1_5r.descriptiveOnly, true);
  assert.equal(report.matchedPolicyTarget1_5r.cohort, 1);
  assert.equal(report.matchedPolicyTarget1_5r.expectancyR, null);
  assert.equal(report.promotion.ready, false);
  assert.ok(report.promotion.reasons.some((reason) => reason.includes("30 decisive")));
});

test("Stage 2 report suppresses rates and promotion when the bounded input is truncated", () => {
  const report = buildStage2ShadowReport([], { sampleTruncated: true });
  assert.equal(report.analysisSuppressed, true);
  assert.equal(report.target1_5r.expectancyR, null);
  assert.equal(report.promotion.ready, false);
  assert.ok(report.promotion.reasons.includes("candidate sample is truncated"));
});

test("1.5R target analysis can use historical deliveries without inventing candidate links", () => {
  const report = buildStage2ShadowReport([], {
    targetCounterfactuals: [
      { outcome_status: "target", pnl_r: 1.5 },
      { outcome_status: "stop", pnl_r: -1 },
    ],
  });

  assert.equal(report.candidates.linkedDelivered, 0);
  assert.equal(report.target1_5r.cohort, 2);
  assert.equal(report.target1_5r.expectancyR, null);
  assert.equal(report.target1_5r.sampleTooSmall, true);
});

test("Stage 2 report emits descriptive rates only at the five-row minimum", () => {
  const report = buildStage2ShadowReport([], {
    targetCounterfactuals: [
      { outcome_status: "target", pnl_r: 1.5 },
      { outcome_status: "target", pnl_r: 1.5 },
      { outcome_status: "target", pnl_r: 1.5 },
      { outcome_status: "stop", pnl_r: -1 },
      { outcome_status: "stop", pnl_r: -1 },
    ],
  });

  assert.equal(report.target1_5r.sampleTooSmall, false);
  assert.equal(report.target1_5r.targetRateDecisivePct, 60);
  assert.equal(report.target1_5r.expectancyR, 0.5);
});

test("target-ledger truncation suppresses target statistics without erasing complete candidate rates", () => {
  const report = buildStage2ShadowReport(Array.from({ length: 5 }, (_, index) => ({
    candidate_id: 9 + index,
    candidate_strategy_version: "stage1-closed-bars-v2",
    shadow_policy_json: shadow(true),
    alert_id: null,
    delivery_status: null,
    live_outcome_status: null,
    live_pnl_r: null,
    counterfactual_outcome_status: null,
    counterfactual_pnl_r: null,
  })), {
    targetSampleTruncated: true,
    targetCounterfactuals: [{ outcome_status: "target", pnl_r: 1.5 }],
  });

  assert.equal(report.analysisSuppressed, true);
  assert.equal(report.gates.opposingSignalVeto.passRatePct, 100);
  assert.equal(report.target1_5r.expectancyR, null);
  assert.equal(report.target1_5r.sampleTruncated, true);
  assert.equal(report.promotion.reasons.includes("target counterfactual sample is truncated"), false);
});

test("partial shadow payloads are counted as invalid instead of crashing the report", () => {
  const report = buildStage2ShadowReport([{
    candidate_id: 10,
    candidate_strategy_version: "stage1-closed-bars-v2",
    shadow_policy_json: JSON.stringify({
      policyVersion: "stage2-shadow-v1",
      gates: {},
      combinedConservativePass: false,
    }),
    alert_id: null,
    delivery_status: null,
    live_outcome_status: null,
    live_pnl_r: null,
    counterfactual_outcome_status: null,
    counterfactual_pnl_r: null,
  }]);

  assert.equal(report.candidates.parsed, 0);
  assert.equal(report.candidates.parseErrors, 1);
  assert.equal(report.promotion.ready, false);
});

test("mixed strategy versions and attribution failures block Stage 2 promotion", () => {
  const report = buildStage2ShadowReport([{
    candidate_id: 20,
    candidate_strategy_version: "future-strategy-v3",
    shadow_policy_json: shadow(true),
    alert_id: null,
    delivery_status: null,
    live_outcome_status: null,
    live_pnl_r: null,
    counterfactual_outcome_status: null,
    counterfactual_pnl_r: null,
  }], { attributionFailures: 2 });

  assert.equal(report.candidates.strategyMismatches, 1);
  assert.equal(report.candidates.parsed, 0);
  assert.ok(report.promotion.reasons.includes("candidate sample contains a non-baseline strategy version"));
  assert.ok(report.promotion.reasons.includes("2 delivered alerts have failed candidate attribution"));
});

test("a right-censored matched policy cohort cannot become promotion-ready", () => {
  const rows: Stage2ShadowReportRow[] = Array.from({ length: 31 }, (_, index) => ({
    candidate_id: 100 + index,
    candidate_strategy_version: "stage1-closed-bars-v2",
    shadow_policy_json: shadow(true),
    alert_id: 1_000 + index,
    delivery_status: "delivered",
    live_outcome_status: index === 30 ? "open" : "target",
    live_pnl_r: index === 30 ? null : 3,
    counterfactual_outcome_status: index === 30 ? "open" : "target",
    counterfactual_pnl_r: index === 30 ? null : 1.5,
  }));

  const report = buildStage2ShadowReport(rows);
  assert.equal(report.matchedPolicyTarget1_5r.outcomes.open, 1);
  assert.equal(report.promotion.ready, false);
  assert.ok(report.promotion.reasons.includes("matched policy counterfactual cohort is right-censored"));
});

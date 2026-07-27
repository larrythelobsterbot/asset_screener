const GATE_NAMES = [
  "opposingSignalVeto",
  "minimumIndependentFamilies",
  "fourHourDirectionalConfirmation",
  "fundingHeadwind",
  "scoreAtLeast4",
  "scoreAtLeast4_5",
] as const;

export type Stage2GateName = typeof GATE_NAMES[number];

type OutcomeStatus = "open" | "target" | "stop" | "expired" | "ambiguous" | "untrackable";
const BASELINE_STRATEGY_VERSION = "stage1-closed-bars-v2" as const;
const MIN_REPORT_SAMPLE = 5;

export interface Stage2ShadowReportRow {
  candidate_id: number;
  candidate_strategy_version: string;
  shadow_policy_json: string;
  alert_id: number | null;
  delivery_status: string | null;
  live_outcome_status: OutcomeStatus | null;
  live_pnl_r: number | null;
  counterfactual_outcome_status: OutcomeStatus | null;
  counterfactual_pnl_r: number | null;
}

export interface Stage2TargetCounterfactualReportRow {
  outcome_status: OutcomeStatus;
  pnl_r: number | null;
}

interface ParsedShadowPolicy {
  policyVersion: "stage2-shadow-v1";
  gates: Record<Stage2GateName, { pass: boolean }>;
  combinedConservativePass: boolean;
}

interface GateSummary {
  pass: number;
  fail: number;
  passRatePct: number | null;
  linkedDeliveredPass: number;
  finiteLiveOutcomePass: number;
  expectancyLivePassR: number | null;
  finiteCounterfactualOutcomePass: number;
  expectancyCounterfactualPassR: number | null;
}

interface OutcomeCounts {
  open: number;
  target: number;
  stop: number;
  expired: number;
  ambiguous: number;
  untrackable: number;
}

export interface Stage2ShadowReport {
  baselineStrategyVersion: typeof BASELINE_STRATEGY_VERSION;
  policyVersion: "stage2-shadow-v1";
  targetPolicyVersion: "target-1_5r-v1";
  analysisSuppressed: boolean;
  candidates: {
    evaluated: number;
    parsed: number;
    parseErrors: number;
    strategyMismatches: number;
    attributionFailures: number;
    linkedDelivered: number;
    combinedConservativePass: number;
    sampleTooSmall: boolean;
  };
  gates: Record<Stage2GateName, GateSummary>;
  target1_5r: {
    cohort: number;
    outcomes: OutcomeCounts;
    finiteOutcomes: number;
    decisive: number;
    targetRateDecisivePct: number | null;
    expectancyR: number | null;
    breakevenTargetRatePct: 40;
    lower95Pct: number | null;
    upper95Pct: number | null;
    descriptiveOnly: true;
    sampleTruncated: boolean;
    sampleTooSmall: boolean;
  };
  matchedPolicyTarget1_5r: {
    cohort: number;
    outcomes: OutcomeCounts;
    finiteOutcomes: number;
    decisive: number;
    targetRateDecisivePct: number | null;
    expectancyR: number | null;
    breakevenTargetRatePct: 40;
    lower95Pct: number | null;
    upper95Pct: number | null;
    sampleTooSmall: boolean;
  };
  promotion: {
    ready: boolean;
    reasons: string[];
  };
}

const finitePnl = (value: number | null): value is number => value != null && Number.isFinite(value);

function parseShadow(value: string): ParsedShadowPolicy | null {
  try {
    const parsed = JSON.parse(value) as Partial<ParsedShadowPolicy>;
    if (parsed.policyVersion !== "stage2-shadow-v1" || !parsed.gates) return null;
    if (typeof parsed.combinedConservativePass !== "boolean") return null;
    for (const gate of GATE_NAMES) {
      if (typeof parsed.gates[gate]?.pass !== "boolean") return null;
    }
    return parsed as ParsedShadowPolicy;
  } catch {
    return null;
  }
}

function wilson95(successes: number, total: number): { lower: number | null; upper: number | null } {
  if (total <= 0) return { lower: null, upper: null };
  const z = 1.959963984540054;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function buildStage2ShadowReport(
  rows: readonly Stage2ShadowReportRow[],
  options: {
    sampleTruncated?: boolean;
    targetSampleTruncated?: boolean;
    targetCounterfactuals?: readonly Stage2TargetCounterfactualReportRow[];
    attributionFailures?: number;
  } = {},
): Stage2ShadowReport {
  const candidateSampleTruncated = options.sampleTruncated === true;
  const targetSampleTruncated = options.targetSampleTruncated === true;
  const baselineRows = rows.filter((row) => row.candidate_strategy_version === BASELINE_STRATEGY_VERSION);
  const strategyMismatches = rows.length - baselineRows.length;
  const parsedRows = baselineRows
    .map((row) => ({ row, shadow: parseShadow(row.shadow_policy_json) }))
    .filter((entry): entry is { row: Stage2ShadowReportRow; shadow: ParsedShadowPolicy } => entry.shadow != null);
  const candidateSampleTooSmall = parsedRows.length < MIN_REPORT_SAMPLE;
  const candidateAnalysisSuppressed = candidateSampleTruncated || candidateSampleTooSmall;
  const linkedRows = parsedRows.filter(({ row }) => row.alert_id != null && row.delivery_status === "delivered");

  const gates = Object.fromEntries(GATE_NAMES.map((gate): [Stage2GateName, GateSummary] => {
    const passing = parsedRows.filter(({ shadow }) => shadow.gates[gate].pass);
    const linkedPassing = passing.filter(({ row }) => row.alert_id != null && row.delivery_status === "delivered");
    const livePnls = linkedPassing
      .filter(({ row }) => row.live_outcome_status === "target" || row.live_outcome_status === "stop" || row.live_outcome_status === "expired")
      .map(({ row }) => row.live_pnl_r)
      .filter(finitePnl);
    const counterfactualPnls = linkedPassing
      .filter(({ row }) => row.counterfactual_outcome_status === "target"
        || row.counterfactual_outcome_status === "stop"
        || row.counterfactual_outcome_status === "expired")
      .map(({ row }) => row.counterfactual_pnl_r)
      .filter(finitePnl);
    return [gate, {
      pass: passing.length,
      fail: parsedRows.length - passing.length,
      passRatePct: candidateAnalysisSuppressed || parsedRows.length === 0 ? null : (passing.length / parsedRows.length) * 100,
      linkedDeliveredPass: linkedPassing.length,
      finiteLiveOutcomePass: livePnls.length,
      expectancyLivePassR: candidateAnalysisSuppressed || livePnls.length < MIN_REPORT_SAMPLE
        ? null
        : livePnls.reduce((sum, value) => sum + value, 0) / livePnls.length,
      finiteCounterfactualOutcomePass: counterfactualPnls.length,
      expectancyCounterfactualPassR: candidateAnalysisSuppressed || counterfactualPnls.length < MIN_REPORT_SAMPLE
        ? null
        : counterfactualPnls.reduce((sum, value) => sum + value, 0) / counterfactualPnls.length,
    }];
  })) as Record<Stage2GateName, GateSummary>;

  const outcomeCounts: OutcomeCounts = {
    open: 0,
    target: 0,
    stop: 0,
    expired: 0,
    ambiguous: 0,
    untrackable: 0,
  };
  const counterfactualRows = options.targetCounterfactuals ?? linkedRows
    .filter(({ row }) => row.counterfactual_outcome_status != null)
    .map(({ row }) => ({
      outcome_status: row.counterfactual_outcome_status!,
      pnl_r: row.counterfactual_pnl_r,
    }));
  const targetSampleTooSmall = counterfactualRows.length < MIN_REPORT_SAMPLE;
  const targetAnalysisSuppressed = targetSampleTruncated || targetSampleTooSmall;
  const analysisSuppressed = candidateAnalysisSuppressed || targetAnalysisSuppressed;
  for (const row of counterfactualRows) outcomeCounts[row.outcome_status] += 1;
  const counterfactualPnls = counterfactualRows
    .filter((row) => row.outcome_status === "target"
      || row.outcome_status === "stop"
      || row.outcome_status === "expired")
    .map((row) => row.pnl_r)
    .filter(finitePnl);
  const decisive = outcomeCounts.target + outcomeCounts.stop;
  const interval = wilson95(outcomeCounts.target, decisive);

  const matchedCounterfactualRows = linkedRows
    .filter(({ shadow, row }) => shadow.combinedConservativePass && row.counterfactual_outcome_status != null)
    .map(({ row }) => ({
      outcome_status: row.counterfactual_outcome_status!,
      pnl_r: row.counterfactual_pnl_r,
    }));
  const matchedOutcomeCounts: OutcomeCounts = {
    open: 0,
    target: 0,
    stop: 0,
    expired: 0,
    ambiguous: 0,
    untrackable: 0,
  };
  for (const row of matchedCounterfactualRows) matchedOutcomeCounts[row.outcome_status] += 1;
  const matchedCounterfactualPnls = matchedCounterfactualRows
    .filter((row) => row.outcome_status === "target"
      || row.outcome_status === "stop"
      || row.outcome_status === "expired")
    .map((row) => row.pnl_r)
    .filter(finitePnl);
  const matchedDecisive = matchedOutcomeCounts.target + matchedOutcomeCounts.stop;
  const matchedSampleTooSmall = matchedCounterfactualRows.length < MIN_REPORT_SAMPLE;
  const matchedAnalysisSuppressed = candidateAnalysisSuppressed || matchedSampleTooSmall;
  const matchedInterval = wilson95(matchedOutcomeCounts.target, matchedDecisive);
  const matchedExpectancy = matchedCounterfactualPnls.length === 0
    ? null
    : matchedCounterfactualPnls.reduce((sum, value) => sum + value, 0) / matchedCounterfactualPnls.length;
  const combinedLinkedDeliveries = linkedRows.filter(({ shadow }) => shadow.combinedConservativePass).length;

  const reasons: string[] = [];
  if (candidateSampleTruncated) reasons.push("candidate sample is truncated");
  if (strategyMismatches > 0) reasons.push("candidate sample contains a non-baseline strategy version");
  if (baselineRows.length !== parsedRows.length) reasons.push("one or more shadow policy payloads are invalid");
  if ((options.attributionFailures ?? 0) > 0) {
    reasons.push(`${options.attributionFailures} delivered alerts have failed candidate attribution`);
  }
  if (combinedLinkedDeliveries !== matchedCounterfactualRows.length) {
    reasons.push("matched policy deliveries are missing counterfactual rows");
  }
  if (matchedOutcomeCounts.open > 0) reasons.push("matched policy counterfactual cohort is right-censored");
  if (matchedOutcomeCounts.ambiguous > 0 || matchedOutcomeCounts.untrackable > 0) {
    reasons.push("matched policy counterfactual cohort contains unresolved evidence states");
  }
  if (matchedDecisive < 30) reasons.push("fewer than 30 decisive matched policy 1.5R counterfactual outcomes");
  if (matchedCounterfactualPnls.length < 30) {
    reasons.push("fewer than 30 finite matched policy 1.5R counterfactual outcomes");
  }
  if (matchedDecisive >= 30 && (matchedInterval.lower == null || matchedInterval.lower <= 0.4)) {
    reasons.push("matched policy 1.5R target-rate lower confidence bound does not exceed the 40% breakeven rate");
  }
  if (matchedCounterfactualPnls.length >= 30 && (matchedExpectancy == null || matchedExpectancy <= 0)) {
    reasons.push("matched policy 1.5R expectancy is not positive");
  }

  return {
    baselineStrategyVersion: BASELINE_STRATEGY_VERSION,
    policyVersion: "stage2-shadow-v1",
    targetPolicyVersion: "target-1_5r-v1",
    analysisSuppressed,
    candidates: {
      evaluated: rows.length,
      parsed: parsedRows.length,
      parseErrors: baselineRows.length - parsedRows.length,
      strategyMismatches,
      attributionFailures: options.attributionFailures ?? 0,
      linkedDelivered: linkedRows.length,
      combinedConservativePass: parsedRows.filter(({ shadow }) => shadow.combinedConservativePass).length,
      sampleTooSmall: candidateSampleTooSmall,
    },
    gates,
    target1_5r: {
      cohort: counterfactualRows.length,
      outcomes: outcomeCounts,
      finiteOutcomes: counterfactualPnls.length,
      decisive,
      targetRateDecisivePct: targetAnalysisSuppressed || decisive < MIN_REPORT_SAMPLE
        ? null
        : (outcomeCounts.target / decisive) * 100,
      expectancyR: targetAnalysisSuppressed || counterfactualPnls.length < MIN_REPORT_SAMPLE
        ? null
        : counterfactualPnls.reduce((sum, value) => sum + value, 0) / counterfactualPnls.length,
      breakevenTargetRatePct: 40,
      lower95Pct: targetAnalysisSuppressed || decisive < MIN_REPORT_SAMPLE || interval.lower == null
        ? null
        : interval.lower * 100,
      upper95Pct: targetAnalysisSuppressed || decisive < MIN_REPORT_SAMPLE || interval.upper == null
        ? null
        : interval.upper * 100,
      descriptiveOnly: true,
      sampleTruncated: targetSampleTruncated,
      sampleTooSmall: targetSampleTooSmall,
    },
    matchedPolicyTarget1_5r: {
      cohort: matchedCounterfactualRows.length,
      outcomes: matchedOutcomeCounts,
      finiteOutcomes: matchedCounterfactualPnls.length,
      decisive: matchedDecisive,
      targetRateDecisivePct: matchedAnalysisSuppressed || matchedDecisive < MIN_REPORT_SAMPLE
        ? null
        : (matchedOutcomeCounts.target / matchedDecisive) * 100,
      expectancyR: matchedAnalysisSuppressed || matchedCounterfactualPnls.length < MIN_REPORT_SAMPLE
        ? null
        : matchedExpectancy,
      breakevenTargetRatePct: 40,
      lower95Pct: matchedAnalysisSuppressed || matchedDecisive < MIN_REPORT_SAMPLE || matchedInterval.lower == null
        ? null
        : matchedInterval.lower * 100,
      upper95Pct: matchedAnalysisSuppressed || matchedDecisive < MIN_REPORT_SAMPLE || matchedInterval.upper == null
        ? null
        : matchedInterval.upper * 100,
      sampleTooSmall: matchedSampleTooSmall,
    },
    promotion: {
      ready: reasons.length === 0,
      reasons,
    },
  };
}

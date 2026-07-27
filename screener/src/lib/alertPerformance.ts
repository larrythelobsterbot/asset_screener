export type AlertDeliveryStatus = "pending" | "delivered" | "failed";
export type AlertOutcomeStatus =
  | "open"
  | "target"
  | "stop"
  | "expired"
  | "ambiguous"
  | "untrackable";

export interface AlertPerformanceInput {
  delivery_status: AlertDeliveryStatus;
  delivery_uncertain?: boolean;
  outcome_status: AlertOutcomeStatus;
  pnl_r: number | null;
  conviction_label: string | null;
  families_json: string | null;
}

export type EvidenceClassification = "insufficient" | "promising" | "weak" | "inconclusive";

export interface EvidenceAssessment {
  classification: EvidenceClassification;
  sampleSize: number;
  targetRate: number | null;
  lower95: number | null;
  upper95: number | null;
  breakevenRate: number;
}

export interface PerformanceGroup {
  key: string;
  attempts: number;
  delivered: number;
  target: number;
  stop: number;
  expired: number;
  ambiguous: number;
  open: number;
  finiteROutcomes: number;
  decisiveTpSl: number;
  expectancyR: number | null;
  targetRateDecisivePct: number | null;
}

export interface AlertPerformanceSummary {
  delivery: { attempts: number; delivered: number; failed: number; unknown: number; pending: number };
  outcomes: {
    open: number;
    target: number;
    stop: number;
    expired: number;
    ambiguous: number;
    untrackable: number;
  };
  resolved: number;
  decisive: number;
  finiteROutcomes: number;
  decisiveTpSl: number;
  targetRateDecisivePct: number | null;
  successRateAllResolvedPct: number | null;
  expectancyR: number | null;
  totalR: number;
  analysisSuppressed: boolean;
  evidence: EvidenceAssessment;
  byConviction: PerformanceGroup[];
  byFamily: PerformanceGroup[];
}

const MIN_EVIDENCE_SAMPLE = 30;
const BREAKEVEN_RATE = 0.25;
const Z_95 = 1.959963984540054;

export function parsePerformanceWindowDays(value: string | null, fallback = 90): number {
  const parsed = value == null ? fallback : Number(value);
  const finite = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(365, Math.max(1, Math.trunc(finite)));
}

export function classifyEvidence(targets: number, decisive: number): EvidenceAssessment {
  if (decisive <= 0) {
    return {
      classification: "insufficient",
      sampleSize: 0,
      targetRate: null,
      lower95: null,
      upper95: null,
      breakevenRate: BREAKEVEN_RATE,
    };
  }

  const p = targets / decisive;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / decisive;
  const center = (p + z2 / (2 * decisive)) / denominator;
  const margin =
    (Z_95 / denominator) *
    Math.sqrt((p * (1 - p)) / decisive + z2 / (4 * decisive * decisive));
  const lower95 = Math.max(0, center - margin);
  const upper95 = Math.min(1, center + margin);

  let classification: EvidenceClassification = "inconclusive";
  if (decisive < MIN_EVIDENCE_SAMPLE) classification = "insufficient";
  else if (lower95 > BREAKEVEN_RATE) classification = "promising";
  else if (upper95 < BREAKEVEN_RATE) classification = "weak";

  return {
    classification,
    sampleSize: decisive,
    targetRate: p,
    lower95,
    upper95,
    breakevenRate: BREAKEVEN_RATE,
  };
}

function resolvedFinitePnl(rows: AlertPerformanceInput[]): number[] {
  return rows
    .filter((row) => row.outcome_status === "target" || row.outcome_status === "stop" || row.outcome_status === "expired")
    .map((row) => row.pnl_r)
    .filter((value): value is number => value != null && Number.isFinite(value));
}

function summarizeGroup(key: string, rows: AlertPerformanceInput[], analysisSuppressed: boolean): PerformanceGroup {
  const target = rows.filter((row) => row.outcome_status === "target").length;
  const stop = rows.filter((row) => row.outcome_status === "stop").length;
  const pnls = resolvedFinitePnl(rows);
  return {
    key,
    attempts: rows.length,
    delivered: rows.filter((row) => row.delivery_status === "delivered").length,
    target,
    stop,
    expired: rows.filter((row) => row.outcome_status === "expired").length,
    ambiguous: rows.filter((row) => row.outcome_status === "ambiguous").length,
    open: rows.filter((row) => row.outcome_status === "open").length,
    finiteROutcomes: pnls.length,
    decisiveTpSl: target + stop,
    expectancyR: !analysisSuppressed && pnls.length > 0 ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : null,
    targetRateDecisivePct: !analysisSuppressed && target + stop > 0 ? (target / (target + stop)) * 100 : null,
  };
}

function grouped(
  rows: AlertPerformanceInput[],
  keysOf: (row: AlertPerformanceInput) => string[],
  analysisSuppressed: boolean,
): PerformanceGroup[] {
  const groups = new Map<string, AlertPerformanceInput[]>();
  for (const row of rows) {
    for (const key of keysOf(row)) {
      const current = groups.get(key) ?? [];
      current.push(row);
      groups.set(key, current);
    }
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => summarizeGroup(key, groupRows, analysisSuppressed))
    .sort((a, b) => b.attempts - a.attempts);
}

function familyKeys(row: AlertPerformanceInput): string[] {
  if (!row.families_json) return [];
  try {
    const parsed = JSON.parse(row.families_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string" && value.length > 0))];
  } catch {
    return [];
  }
}

export function summarizeAlertPerformance(
  rows: AlertPerformanceInput[],
  options: { sampleTruncated?: boolean } = {},
): AlertPerformanceSummary {
  const analysisSuppressed = options.sampleTruncated === true;
  const deliveredRows = rows.filter((row) => row.delivery_status === "delivered");
  const target = deliveredRows.filter((row) => row.outcome_status === "target").length;
  const stop = deliveredRows.filter((row) => row.outcome_status === "stop").length;
  const expired = deliveredRows.filter((row) => row.outcome_status === "expired").length;
  const ambiguous = deliveredRows.filter((row) => row.outcome_status === "ambiguous").length;
  const resolved = target + stop + expired + ambiguous;
  const decisive = target + stop;
  const pnls = resolvedFinitePnl(deliveredRows);
  const totalR = pnls.reduce((sum, value) => sum + value, 0);

  return {
    delivery: {
      attempts: rows.length,
      delivered: deliveredRows.length,
      failed: rows.filter((row) => row.delivery_status === "failed" && !row.delivery_uncertain).length,
      unknown: rows.filter((row) => row.delivery_status === "failed" && row.delivery_uncertain === true).length,
      pending: rows.filter((row) => row.delivery_status === "pending").length,
    },
    outcomes: {
      open: deliveredRows.filter((row) => row.outcome_status === "open").length,
      target,
      stop,
      expired,
      ambiguous,
      untrackable: deliveredRows.filter((row) => row.outcome_status === "untrackable").length,
    },
    resolved,
    decisive,
    finiteROutcomes: pnls.length,
    decisiveTpSl: decisive,
    targetRateDecisivePct: !analysisSuppressed && decisive > 0 ? (target / decisive) * 100 : null,
    successRateAllResolvedPct: !analysisSuppressed && resolved > 0 ? (target / resolved) * 100 : null,
    expectancyR: !analysisSuppressed && pnls.length > 0 ? totalR / pnls.length : null,
    totalR,
    analysisSuppressed,
    evidence: analysisSuppressed
      ? { classification: "insufficient", sampleSize: decisive, targetRate: null, lower95: null, upper95: null, breakevenRate: BREAKEVEN_RATE }
      : classifyEvidence(target, decisive),
    byConviction: grouped(deliveredRows, (row) => [row.conviction_label || "Unknown"], analysisSuppressed),
    byFamily: grouped(deliveredRows, familyKeys, analysisSuppressed),
  };
}

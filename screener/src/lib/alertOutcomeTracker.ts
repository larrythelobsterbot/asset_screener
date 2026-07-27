import {
  candlesInRange,
  ensureTargetCounterfactuals,
  listOpenTelegramAlerts,
  listOpenTargetCounterfactuals,
  priceSnapshotsInRange,
  reconcileStalePendingTelegramAlerts,
  updateTargetCounterfactualOutcome,
  updateTelegramAlertOutcome,
  type CandleRow,
  type OpenTargetCounterfactualRow,
  type PriceObservationRow,
  type TargetCounterfactualOutcomeUpdate,
  type TelegramAlertRow,
  type TelegramOutcomeUpdate,
} from "./db";
import { displayScaleOf } from "./hyperliquid";
import { evaluateAlertOutcome, firstFullyPostAlertCandleStart } from "./alertOutcomes";

const HOUR_MS = 60 * 60 * 1_000;
const EVALUATION_INTERVAL_MS = 60_000;
const PENDING_ACK_TIMEOUT_MS = 10 * 60_000;
const EVALUATOR_STALE_AFTER_MS = 5 * 60_000;
const trackerStartedAt = Date.now();

export interface AlertOutcomeEvaluationReport {
  scanned: number;
  updated: number;
  open: number;
  errors: number;
  reconciledUnknown: number;
  counterfactual?: TargetCounterfactualEvaluationReport;
}

export interface AlertOutcomeTrackerDeps {
  listOpen: (now: number, limit: number) => TelegramAlertRow[];
  snapshots: (symbol: string, fromTs: number, toTs: number, limit: number) => PriceObservationRow[];
  candles: (symbol: string, interval: string, fromTs: number, toTs: number, limit: number) => CandleRow[];
  displayScale: (symbol: string) => number;
  update: (id: number, update: TelegramOutcomeUpdate) => boolean;
  reconcilePending?: (cutoff: number, observedAt: number) => number;
  now: () => number;
}

const defaultDeps: AlertOutcomeTrackerDeps = {
  listOpen: listOpenTelegramAlerts,
  snapshots: priceSnapshotsInRange,
  candles: candlesInRange,
  displayScale: displayScaleOf,
  update: updateTelegramAlertOutcome,
  reconcilePending: reconcileStalePendingTelegramAlerts,
  now: Date.now,
};

export interface TargetCounterfactualEvaluationReport {
  seeded: number;
  scanned: number;
  updated: number;
  open: number;
  errors: number;
}

export interface TargetCounterfactualTrackerDeps {
  ensure: (now: number) => number;
  listOpen: (now: number, limit: number) => OpenTargetCounterfactualRow[];
  snapshots: (symbol: string, fromTs: number, toTs: number, limit: number) => PriceObservationRow[];
  candles: (symbol: string, interval: string, fromTs: number, toTs: number, limit: number) => CandleRow[];
  displayScale: (symbol: string) => number;
  update: (id: number, update: TargetCounterfactualOutcomeUpdate) => boolean;
  now: () => number;
}

const defaultTargetCounterfactualDeps: TargetCounterfactualTrackerDeps = {
  ensure: ensureTargetCounterfactuals,
  listOpen: listOpenTargetCounterfactuals,
  snapshots: priceSnapshotsInRange,
  candles: candlesInRange,
  displayScale: displayScaleOf,
  update: updateTargetCounterfactualOutcome,
  now: Date.now,
};

function outcomeNote(status: TelegramOutcomeUpdate["outcome_status"]): string {
  switch (status) {
    case "target": return "target touched before stop";
    case "stop": return "stop touched before target";
    case "ambiguous": return "target and stop touched in the same 1h evidence interval";
    case "expired": return "neither target nor stop touched before 48h expiry";
    case "untrackable": return "trade card or market evidence unavailable";
  }
}

interface OutcomeEvidenceSubject {
  symbol: string;
  delivered_at: number | null;
  expires_at: number;
}

interface OutcomeEvidenceDeps {
  snapshots: (symbol: string, fromTs: number, toTs: number, limit: number) => PriceObservationRow[];
  candles: (symbol: string, interval: string, fromTs: number, toTs: number, limit: number) => CandleRow[];
  displayScale: (symbol: string) => number;
}

function prepareOutcomeEvidence(
  subject: OutcomeEvidenceSubject,
  now: number,
  deps: OutcomeEvidenceDeps,
) {
  if (subject.delivered_at === null) {
    throw new Error("confirmed Telegram delivery timestamp unavailable");
  }
  const alertAt = subject.delivered_at;
  const firstFullCandle = firstFullyPostAlertCandleStart(alertAt);
  const evidenceThrough = Math.min(now, subject.expires_at);
  const snapshotTo = Math.min(evidenceThrough, firstFullCandle - 1);
  const openingSnapshots = snapshotTo > alertAt
    ? deps.snapshots(subject.symbol, alertAt + 1, snapshotTo, 500).map((point) => ({
        ts: point.ts,
        high: point.mark,
        low: point.mark,
        mark: point.mark,
      }))
    : [];
  // Once an alert is expired, the candle containing the expiry instant may
  // include highs/lows recorded after expiry. Exclude that partial candle and
  // use sampled marks for only its pre-expiry tail instead.
  const replayingExpired = now >= subject.expires_at;
  const candleThrough = replayingExpired
    ? Math.floor((subject.expires_at - HOUR_MS) / HOUR_MS) * HOUR_MS
    : evidenceThrough;
  const tailStart = candleThrough + HOUR_MS;
  const tailSnapshots = replayingExpired && tailStart < subject.expires_at
    ? deps.snapshots(subject.symbol, tailStart, subject.expires_at, 500).map((point) => ({
        ts: point.ts,
        high: point.mark,
        low: point.mark,
        mark: point.mark,
      }))
    : [];
  const scale = deps.displayScale(subject.symbol);
  const candles = candleThrough >= firstFullCandle
    ? deps.candles(subject.symbol, "1h", firstFullCandle, candleThrough, 100).map((candle) => ({
        // Timestamp candle evidence at interval close, not open. This both
        // avoids claiming an outcome before it could have happened and
        // naturally excludes the still-forming current candle.
        ts: candle.t + HOUR_MS,
        high: candle.h * scale,
        low: candle.l * scale,
        close: candle.c * scale,
      }))
    : [];
  return {
    alertAt,
    evidenceThrough,
    snapshots: [...openingSnapshots, ...tailSnapshots],
    candles,
  };
}

export async function evaluateOpenTargetCounterfactuals(
  deps: TargetCounterfactualTrackerDeps = defaultTargetCounterfactualDeps,
): Promise<TargetCounterfactualEvaluationReport> {
  const now = deps.now();
  const seeded = deps.ensure(now);
  const counterfactuals = deps.listOpen(now, 500);
  const report: TargetCounterfactualEvaluationReport = {
    seeded,
    scanned: counterfactuals.length,
    updated: 0,
    open: 0,
    errors: 0,
  };

  for (const counterfactual of counterfactuals) {
    try {
      const { alertAt, evidenceThrough, snapshots, candles } = prepareOutcomeEvidence(counterfactual, now, deps);

      const result = evaluateAlertOutcome({
        direction: counterfactual.direction,
        entry: counterfactual.entry_price,
        stop: counterfactual.stop_price,
        target: counterfactual.target_price,
        alertAt,
        now,
        snapshots,
        candles,
        expiresAt: counterfactual.expires_at,
      });
      if (result.status === "open") {
        report.open += 1;
        continue;
      }

      const update: TargetCounterfactualOutcomeUpdate = {
        outcome_status: result.status,
        outcome_at: result.resolvedAt ?? Math.min(now, counterfactual.expires_at),
        outcome_price: result.exitPrice ?? null,
        pnl_r: result.rMultiple ?? null,
        evaluated_through: evidenceThrough,
        outcome_note: outcomeNote(result.status),
        outcome_provenance: "price_snapshots+1h_candles:target-1_5r-v1",
      };
      if (deps.update(counterfactual.id, update)) report.updated += 1;
    } catch (error) {
      report.errors += 1;
      console.warn(
        `[alert-counterfactuals] failed id=${counterfactual.id} symbol=${counterfactual.symbol}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return report;
}

export async function evaluateOpenTelegramAlerts(
  deps: AlertOutcomeTrackerDeps = defaultDeps,
): Promise<AlertOutcomeEvaluationReport> {
  const now = deps.now();
  const reconciledUnknown = deps.reconcilePending?.(now - PENDING_ACK_TIMEOUT_MS, now) ?? 0;
  const alerts = deps.listOpen(now, 500);
  const report: AlertOutcomeEvaluationReport = {
    scanned: alerts.length,
    updated: 0,
    open: 0,
    errors: 0,
    reconciledUnknown,
  };

  for (const alert of alerts) {
    try {
      if (alert.delivered_at === null) {
        const update: TelegramOutcomeUpdate = {
          outcome_status: "untrackable",
          outcome_at: now,
          outcome_price: null,
          pnl_r: null,
          evaluated_through: now,
          outcome_note: "confirmed Telegram delivery timestamp unavailable",
          outcome_provenance: "delivery",
        };
        if (deps.update(alert.id, update)) report.updated += 1;
        continue;
      }
      const { alertAt, evidenceThrough, snapshots, candles } = prepareOutcomeEvidence(alert, now, deps);

      const result = evaluateAlertOutcome({
        direction: alert.direction,
        entry: alert.entry_price,
        stop: alert.stop_price,
        target: alert.target_price,
        alertAt,
        now,
        snapshots,
        candles,
        expiresAt: alert.expires_at,
      });

      if (result.status === "open") {
        report.open += 1;
        continue;
      }

      const update: TelegramOutcomeUpdate = {
        outcome_status: result.status,
        outcome_at: result.resolvedAt ?? Math.min(now, alert.expires_at),
        outcome_price: result.exitPrice ?? null,
        pnl_r: result.rMultiple ?? null,
        evaluated_through: evidenceThrough,
        outcome_note: outcomeNote(result.status),
        outcome_provenance: "price_snapshots+1h_candles",
      };
      if (deps.update(alert.id, update)) report.updated += 1;
    } catch (error) {
      report.errors += 1;
      console.warn(
        `[alert-outcomes] failed alert id=${alert.id} symbol=${alert.symbol}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return report;
}

export async function evaluateAllAlertOutcomes(
  liveDeps: AlertOutcomeTrackerDeps = defaultDeps,
  counterfactualDeps: TargetCounterfactualTrackerDeps = defaultTargetCounterfactualDeps,
): Promise<AlertOutcomeEvaluationReport> {
  const live = await evaluateOpenTelegramAlerts(liveDeps);
  const counterfactual = await evaluateOpenTargetCounterfactuals(counterfactualDeps);
  return { ...live, counterfactual };
}

export interface AlertOutcomeTrackerState extends AlertOutcomeEvaluationReport {
  running: boolean;
  lastRunAt: number | null;
  lastSuccessfulAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

export interface AlertOutcomeScheduler {
  kick: () => Promise<AlertOutcomeEvaluationReport> | null;
  getState: () => AlertOutcomeTrackerState;
}

export function createAlertOutcomeScheduler(
  run: () => Promise<AlertOutcomeEvaluationReport>,
  minIntervalMs = EVALUATION_INTERVAL_MS,
  clock: () => number = Date.now,
): AlertOutcomeScheduler {
  let active: Promise<AlertOutcomeEvaluationReport> | null = null;
  let lastStartedAt: number | null = null;
  let state: AlertOutcomeTrackerState = {
    running: false,
    lastRunAt: null,
    lastSuccessfulAt: null,
    lastDurationMs: null,
    lastError: null,
    scanned: 0,
    updated: 0,
    open: 0,
    errors: 0,
    reconciledUnknown: 0,
  };

  return {
    kick() {
      if (active) return active;
      const startedAt = clock();
      if (lastStartedAt != null && startedAt - lastStartedAt < minIntervalMs) return null;
      lastStartedAt = startedAt;
      state = { ...state, running: true, lastRunAt: startedAt, lastError: null };

      const current = run()
        .then((report) => {
          state = {
            ...state,
            ...report,
            running: false,
            lastSuccessfulAt: clock(),
            lastDurationMs: Math.max(0, clock() - startedAt),
          };
          return report;
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          state = {
            ...state,
            running: false,
            errors: state.errors + 1,
            lastDurationMs: Math.max(0, clock() - startedAt),
            lastError: message.slice(0, 500),
          };
          return { scanned: 0, updated: 0, open: 0, errors: 1, reconciledUnknown: 0 };
        });
      active = current;
      void current.finally(() => {
        if (active === current) active = null;
      });
      return current;
    },
    getState() {
      return { ...state };
    },
  };
}

const scheduler = createAlertOutcomeScheduler(() => evaluateAllAlertOutcomes());

export function kickAlertOutcomeEvaluation(): void {
  void scheduler.kick();
}

export function runAlertOutcomeEvaluation(): Promise<AlertOutcomeEvaluationReport> | null {
  return scheduler.kick();
}

export function getAlertOutcomeTrackerState(): AlertOutcomeTrackerState {
  return scheduler.getState();
}

export interface AlertOutcomeTrackerHealth extends AlertOutcomeTrackerState {
  status: "starting" | "running" | "healthy" | "stale";
  stale: boolean;
  ageSinceSuccessMs: number | null;
}

export function classifyAlertOutcomeTrackerHealth(
  state: AlertOutcomeTrackerState,
  now = Date.now(),
  startedAt = trackerStartedAt,
  staleAfterMs = EVALUATOR_STALE_AFTER_MS,
): AlertOutcomeTrackerHealth {
  const ageSinceSuccessMs = state.lastSuccessfulAt == null ? null : Math.max(0, now - state.lastSuccessfulAt);
  const stale = ageSinceSuccessMs == null
    ? now - startedAt > staleAfterMs
    : ageSinceSuccessMs > staleAfterMs;
  const status = stale
    ? "stale"
    : state.running
      ? "running"
      : state.lastSuccessfulAt == null
        ? "starting"
        : "healthy";
  return { ...state, status, stale, ageSinceSuccessMs };
}

export function getAlertOutcomeTrackerHealth(now = Date.now()): AlertOutcomeTrackerHealth {
  return classifyAlertOutcomeTrackerHealth(scheduler.getState(), now);
}

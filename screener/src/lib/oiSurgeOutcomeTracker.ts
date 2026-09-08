import type {
  OiSurgeOutcomeHorizon,
  OiSurgeOutcomeRow,
  PendingOiSurgeOutcomeEvent,
  PriceObservationRow,
  SnapshotPointFull,
} from "./db";
import {
  listOiSurgeOutcomes,
  listPendingOiSurgeOutcomeEvents,
  priceSnapshotsInRange,
  snapshotFullAtBounded,
  upsertOiSurgeOutcome,
} from "./db";

const HOUR_MS = 60 * 60_000;
const EVIDENCE_TOLERANCE_MS = 10 * 60_000;
const HORIZONS: ReadonlyArray<{ horizon: OiSurgeOutcomeHorizon; offsetMs: number }> = [
  { horizon: "1h", offsetMs: HOUR_MS },
  { horizon: "4h", offsetMs: 4 * HOUR_MS },
  { horizon: "24h", offsetMs: 24 * HOUR_MS },
];

export interface OiSurgeOutcomeTrackerDeps {
  listPending: (now: number, limit: number) => PendingOiSurgeOutcomeEvent[];
  listExisting: (eventId: number) => OiSurgeOutcomeRow[];
  snapshot: (
    targetAt: number,
    toleranceMs: number,
    symbols: string[],
  ) => Map<string, SnapshotPointFull>;
  series?: (
    symbol: string,
    fromAt: number,
    toAt: number,
    limit: number,
  ) => PriceObservationRow[];
  insert: (row: OiSurgeOutcomeRow) => boolean;
  now: () => number;
}

export interface OiSurgeOutcomeEvaluation {
  scanned: number;
  inserted: number;
  missing: number;
  untrackable: number;
  errors: number;
}

const defaultDeps: OiSurgeOutcomeTrackerDeps = {
  listPending: listPendingOiSurgeOutcomeEvents,
  listExisting: listOiSurgeOutcomes,
  snapshot: snapshotFullAtBounded,
  series: priceSnapshotsInRange,
  insert: upsertOiSurgeOutcome,
  now: Date.now,
};

export function evaluateOiSurgeOutcomes(
  deps: OiSurgeOutcomeTrackerDeps = defaultDeps,
  limit = 500,
): OiSurgeOutcomeEvaluation {
  const now = deps.now();
  const subjects = deps.listPending(now, limit);
  const report: OiSurgeOutcomeEvaluation = {
    scanned: subjects.length,
    inserted: 0,
    missing: 0,
    untrackable: 0,
    errors: 0,
  };

  for (const subject of subjects) {
    try {
      const existing = new Set(deps.listExisting(subject.eventId).map((row) => row.horizon));
      for (const definition of HORIZONS) {
        if (existing.has(definition.horizon)) continue;
        const targetAt = subject.startedAt + definition.offsetMs;
        if (now < targetAt + EVIDENCE_TOLERANCE_MS) continue;

        let outcome: OiSurgeOutcomeRow;
        if (!Number.isFinite(subject.entryMark) || subject.entryMark <= 0) {
          outcome = {
            event_id: subject.eventId,
            horizon: definition.horizon,
            target_at: targetAt,
            status: "untrackable",
            snapshot_at: null,
            mark: null,
            return_pct: null,
            abs_return_pct: null,
            high_return_pct: null,
            low_return_pct: null,
            observed_at: now,
            note: "OI surge entry mark unavailable",
          };
        } else {
          const point = deps.snapshot(targetAt, EVIDENCE_TOLERANCE_MS, [subject.symbol])
            .get(subject.symbol);
          if (!point || !Number.isFinite(point.mark) || point.mark <= 0) {
            outcome = {
              event_id: subject.eventId,
              horizon: definition.horizon,
              target_at: targetAt,
              status: "missing",
              snapshot_at: null,
              mark: null,
              return_pct: null,
              abs_return_pct: null,
              high_return_pct: null,
              low_return_pct: null,
              observed_at: now,
              note: "No bounded snapshot near the OI surge outcome horizon",
            };
          } else {
            const returnPct = ((point.mark - subject.entryMark) / subject.entryMark) * 100;
            const pathReturns = [0, returnPct];
            for (const observation of deps.series?.(
              subject.symbol,
              subject.startedAt,
              targetAt,
              5_000,
            ) ?? []) {
              if (Number.isFinite(observation.mark) && observation.mark > 0) {
                pathReturns.push(((observation.mark - subject.entryMark) / subject.entryMark) * 100);
              }
            }
            outcome = {
              event_id: subject.eventId,
              horizon: definition.horizon,
              target_at: targetAt,
              status: "observed",
              snapshot_at: point.ts,
              mark: point.mark,
              return_pct: returnPct,
              abs_return_pct: Math.abs(returnPct),
              high_return_pct: Math.max(...pathReturns),
              low_return_pct: Math.min(...pathReturns),
              observed_at: now,
              note: null,
            };
          }
        }

        if (deps.insert(outcome)) {
          report.inserted += 1;
          if (outcome.status === "missing") report.missing += 1;
          if (outcome.status === "untrackable") report.untrackable += 1;
          existing.add(definition.horizon);
        }
      }
    } catch {
      report.errors += 1;
    }
  }

  return report;
}

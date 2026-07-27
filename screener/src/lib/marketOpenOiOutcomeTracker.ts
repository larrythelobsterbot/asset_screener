import type {
  MarketOpenOiOutcomeHorizon,
  MarketOpenOiOutcomeRow,
  SnapshotPointFull,
} from "./db";
import {
  listMarketOpenOiOutcomes,
  listPendingMarketOpenOiOutcomeItems,
  snapshotFullAtBounded,
  upsertMarketOpenOiOutcome,
} from "./db";

const HOUR_MS = 60 * 60_000;
const EVIDENCE_TOLERANCE_MS = 10 * 60_000;
const HORIZONS: Array<{ horizon: MarketOpenOiOutcomeHorizon; offsetMs: number }> = [
  { horizon: "open", offsetMs: 0 },
  { horizon: "1h", offsetMs: HOUR_MS },
  { horizon: "4h", offsetMs: 4 * HOUR_MS },
  { horizon: "24h", offsetMs: 24 * HOUR_MS },
];

export interface MarketOpenOiOutcomeSubject {
  itemId: number;
  symbol: string;
  openAt: number;
}

export interface MarketOpenOiOutcomeTrackerDeps {
  listPending: (now: number, limit: number) => MarketOpenOiOutcomeSubject[];
  listExisting: (itemId: number) => MarketOpenOiOutcomeRow[];
  snapshot: (
    targetAt: number,
    toleranceMs: number,
    symbols: string[],
  ) => Map<string, SnapshotPointFull>;
  insert: (row: MarketOpenOiOutcomeRow) => boolean;
  now: () => number;
}

export interface MarketOpenOiOutcomeEvaluation {
  scanned: number;
  inserted: number;
  missing: number;
  errors: number;
}

const defaultMarketOpenOiOutcomeTrackerDeps: MarketOpenOiOutcomeTrackerDeps = {
  listPending: listPendingMarketOpenOiOutcomeItems,
  listExisting: listMarketOpenOiOutcomes,
  snapshot: snapshotFullAtBounded,
  insert: upsertMarketOpenOiOutcome,
  now: Date.now,
};

export function evaluateMarketOpenOiOutcomes(
  deps: MarketOpenOiOutcomeTrackerDeps = defaultMarketOpenOiOutcomeTrackerDeps,
  limit = 500,
): MarketOpenOiOutcomeEvaluation {
  const now = deps.now();
  const subjects = deps.listPending(now, limit);
  const report: MarketOpenOiOutcomeEvaluation = {
    scanned: subjects.length,
    inserted: 0,
    missing: 0,
    errors: 0,
  };

  for (const subject of subjects) {
    try {
      const existing = new Map(deps.listExisting(subject.itemId).map((row) => [row.horizon, row]));
      let openMark = existing.get("open")?.status === "observed"
        ? existing.get("open")?.mark ?? null
        : null;

      for (const definition of HORIZONS) {
        if (existing.has(definition.horizon)) continue;
        const targetAt = subject.openAt + definition.offsetMs;
        if (now < targetAt + EVIDENCE_TOLERANCE_MS) continue;
        const point = deps.snapshot(targetAt, EVIDENCE_TOLERANCE_MS, [subject.symbol]).get(subject.symbol);

        let outcome: MarketOpenOiOutcomeRow;
        if (definition.horizon === "open") {
          if (point && Number.isFinite(point.mark) && point.mark > 0) {
            openMark = point.mark;
            outcome = {
              item_id: subject.itemId,
              horizon: "open",
              target_at: targetAt,
              status: "observed",
              snapshot_at: point.ts,
              mark: point.mark,
              return_pct: null,
              observed_at: now,
              note: null,
            };
          } else {
            outcome = {
              item_id: subject.itemId,
              horizon: "open",
              target_at: targetAt,
              status: "missing",
              snapshot_at: null,
              mark: null,
              return_pct: null,
              observed_at: now,
              note: "No bounded snapshot near the cash open",
            };
          }
        } else if (openMark === null) {
          outcome = {
            item_id: subject.itemId,
            horizon: definition.horizon,
            target_at: targetAt,
            status: "untrackable",
            snapshot_at: null,
            mark: null,
            return_pct: null,
            observed_at: now,
            note: "Cash-open baseline unavailable",
          };
        } else if (!point || !Number.isFinite(point.mark) || point.mark <= 0) {
          outcome = {
            item_id: subject.itemId,
            horizon: definition.horizon,
            target_at: targetAt,
            status: "missing",
            snapshot_at: null,
            mark: null,
            return_pct: null,
            observed_at: now,
            note: "No bounded snapshot near the outcome horizon",
          };
        } else {
          outcome = {
            item_id: subject.itemId,
            horizon: definition.horizon,
            target_at: targetAt,
            status: "observed",
            snapshot_at: point.ts,
            mark: point.mark,
            return_pct: ((point.mark - openMark) / openMark) * 100,
            observed_at: now,
            note: null,
          };
        }

        if (deps.insert(outcome)) {
          report.inserted += 1;
          if (outcome.status !== "observed") report.missing += 1;
          existing.set(definition.horizon, outcome);
        }
      }
    } catch {
      report.errors += 1;
    }
  }
  return report;
}

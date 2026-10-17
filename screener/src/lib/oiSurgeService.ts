import { sectorOf, type Sector } from "@/config/sectors";
import {
  getOiSurgeEvent,
  latestSnapshots,
  markOiSurgeEventPilotEligible,
  reserveOiSurgeEvent,
  snapshotFullAtBounded,
  type NewOiSurgeEvent,
  type OiSurgeReservation,
  type PriceSnapshotRow,
  type SnapshotPointFull,
} from "./db";
import { displayScaleOf } from "./hyperliquid";
import {
  DEFAULT_OI_SURGE_POLICY,
  OI_SURGE_POLICY_VERSION,
  deriveOiSurgeObservation,
  selectPersistentOiSurgeDetection,
  type OiSurgeDetection,
  type OiSurgeAlertMode,
  type OiSurgeHorizon,
  type OiSurgeObservation,
  type OiSurgePolicy,
  type OiSurgeSnapshot,
} from "./oiSurge";
import {
  evaluateOiSurgeOutcomes,
  type OiSurgeOutcomeEvaluation,
} from "./oiSurgeOutcomeTracker";
import {
  deliverExtremeOiSurgeEvent,
  getOiSurgeAlertMode,
  resumeOiSurgeDeliveries,
  type OiSurgeRecoverySummary,
} from "./oiSurgeDelivery";

export interface OiSurgeScannerDeps {
  latest: () => Map<string, PriceSnapshotRow>;
  snapshot: (
    targetAt: number,
    toleranceMs: number,
    symbols: string[],
  ) => Map<string, SnapshotPointFull>;
  displayScale: (symbol: string) => number;
  sector: (symbol: string) => Sector;
  reserve: (event: NewOiSurgeEvent, threadMs: number) => OiSurgeReservation;
  onReserved?: (event: NewOiSurgeEvent, reservation: OiSurgeReservation) => void;
  now: () => number;
}

export interface OiSurgeScanReport {
  status: "ok" | "warming" | "stale";
  anchorAt: number | null;
  scanned: number;
  confirmed: number;
  inserted: number;
  updated: number;
  errors: number;
}

const defaultScannerDeps: OiSurgeScannerDeps = {
  latest: latestSnapshots,
  snapshot: snapshotFullAtBounded,
  displayScale: displayScaleOf,
  sector: sectorOf,
  reserve: reserveOiSurgeEvent,
  now: Date.now,
};

export interface OiSurgePilotEligibilityDeps {
  mode: () => OiSurgeAlertMode;
  markEligible: typeof markOiSurgeEventPilotEligible;
  getEvent: typeof getOiSurgeEvent;
}

const defaultPilotEligibilityDeps: OiSurgePilotEligibilityDeps = {
  mode: getOiSurgeAlertMode,
  markEligible: markOiSurgeEventPilotEligible,
  getEvent: getOiSurgeEvent,
};

export function selectOiSurgePilotCandidate(
  event: NewOiSurgeEvent,
  reservation: OiSurgeReservation,
  deps: OiSurgePilotEligibilityDeps = defaultPilotEligibilityDeps,
): number | null {
  if (deps.mode() !== "extreme-pilot") return null;
  if (reservation.kind === "inserted"
      && !deps.markEligible(reservation.id, event.observed_at)) return null;
  if (event.severity !== "extreme") return null;
  const stored = deps.getEvent(reservation.id);
  return stored?.severity === "extreme" && stored.pilot_eligible_at != null
    ? reservation.id
    : null;
}

function asSnapshot(point: SnapshotPointFull): OiSurgeSnapshot {
  return {
    ts: point.ts,
    mark: point.mark,
    oi: point.oi,
    funding: point.funding,
    volume: point.volume,
  };
}

function evidenceOf(detection: OiSurgeDetection) {
  return {
    policyVersion: OI_SURGE_POLICY_VERSION,
    mode: "shadow" as const,
    detectedAt: detection.detectedAt,
    primaryHorizon: detection.primary.horizon,
    severity: detection.severity,
    horizons: detection.horizons,
    lanes: detection.lanes,
    observations: detection.observations.map((observation) => ({
      horizon: observation.horizon,
      currentAt: observation.currentTs,
      priorAt: observation.priorTs,
      currentMark: observation.currentMark,
      priorMark: observation.priorMark,
      currentOiCoins: observation.currentOiCoins,
      priorOiCoins: observation.priorOiCoins,
      currentOiUsd: observation.currentOiUsd,
      priorOiUsd: observation.priorOiUsd,
      oiCoinsChangePct: observation.oiCoinsChangePct,
      oiQuantityDeltaUsd: observation.oiQuantityDeltaUsd,
      oiUsdDelta: observation.oiUsdDelta,
      priceChangePct: observation.priceChangePct,
      fundingHourly: observation.fundingHourly,
      volume24h: observation.volume24h,
      quadrant: observation.quadrant,
      severity: observation.severity,
      lanes: observation.lanes,
    })),
  };
}

function eventOf(
  detection: OiSurgeDetection,
  sector: Sector,
  observedAt: number,
): NewOiSurgeEvent {
  const primary = detection.primary;
  if (
    primary.currentOiCoins < 0
    || primary.volume24h < 0
    || !primary.quadrant.startsWith("expanding_")
  ) {
    throw new Error("Confirmed OI surge is missing expansion evidence");
  }
  return {
    policy_version: OI_SURGE_POLICY_VERSION,
    source: "hyperliquid",
    symbol: detection.symbol,
    sector,
    detected_at: detection.detectedAt,
    severity: detection.severity,
    primary_horizon: primary.horizon,
    quadrant: primary.quadrant as NewOiSurgeEvent["quadrant"],
    entry_mark: primary.currentMark,
    entry_oi_usd: primary.currentOiUsd,
    oi_coins_change_pct: primary.oiCoinsChangePct,
    oi_quantity_delta_usd: primary.oiQuantityDeltaUsd,
    price_change_pct: primary.priceChangePct,
    volume_24h: primary.volume24h,
    funding_hourly: primary.fundingHourly,
    horizons: detection.horizons,
    lanes: detection.lanes,
    evidence: evidenceOf(detection),
    observed_at: Math.max(observedAt, detection.detectedAt),
  };
}

export function scanOiSurges(
  deps: OiSurgeScannerDeps = defaultScannerDeps,
  policy: OiSurgePolicy = DEFAULT_OI_SURGE_POLICY,
): OiSurgeScanReport {
  const base: Omit<OiSurgeScanReport, "status" | "anchorAt"> = {
    scanned: 0,
    confirmed: 0,
    inserted: 0,
    updated: 0,
    errors: 0,
  };
  const latest = deps.latest();
  if (latest.size === 0) return { status: "warming", anchorAt: null, ...base };

  const anchorAt = Math.max(...[...latest.values()].map((row) => row.ts));
  const now = deps.now();
  if (!Number.isFinite(anchorAt) || now - anchorAt > policy.currentSnapshotMaxAgeMs) {
    return { status: "stale", anchorAt, ...base };
  }

  const symbols = [...latest.values()]
    .filter((row) => anchorAt - row.ts <= policy.currentSnapshotMaxAgeMs)
    .map((row) => row.symbol)
    .sort();
  const report: OiSurgeScanReport = {
    status: "ok",
    anchorAt,
    ...base,
    scanned: symbols.length,
  };
  if (symbols.length === 0) return report;
  const horizons = (Object.keys(policy.horizons) as OiSurgeHorizon[])
    .map((horizon) => ({ horizon, ...policy.horizons[horizon] }));

  const current = deps.snapshot(anchorAt, policy.currentSnapshotMaxAgeMs, symbols);
  const confirmationAt = anchorAt - policy.confirmationOffsetMs;
  const confirmation = deps.snapshot(
    confirmationAt,
    policy.confirmationMaxGapMs,
    symbols,
  );
  const currentPrior = new Map<OiSurgeHorizon, Map<string, SnapshotPointFull>>();
  const confirmationPrior = new Map<OiSurgeHorizon, Map<string, SnapshotPointFull>>();
  for (const horizon of horizons) {
    currentPrior.set(
      horizon.horizon,
      deps.snapshot(anchorAt - horizon.lookbackMs, horizon.toleranceMs, symbols),
    );
    confirmationPrior.set(
      horizon.horizon,
      deps.snapshot(confirmationAt - horizon.lookbackMs, horizon.toleranceMs, symbols),
    );
  }

  for (const symbol of symbols) {
    try {
      const currentPoint = current.get(symbol);
      const confirmationPoint = confirmation.get(symbol);
      if (!currentPoint || !confirmationPoint) continue;

      const currentObservations: OiSurgeObservation[] = [];
      const confirmationObservations: OiSurgeObservation[] = [];
      for (const horizon of horizons) {
        const prior = currentPrior.get(horizon.horizon)?.get(symbol);
        const confirmationLookback = confirmationPrior.get(horizon.horizon)?.get(symbol);
        if (prior) {
          const observation = deriveOiSurgeObservation({
            symbol,
            horizon: horizon.horizon,
            current: asSnapshot(currentPoint),
            prior: asSnapshot(prior),
            displayScale: deps.displayScale(symbol),
            policy,
          });
          if (observation) currentObservations.push(observation);
        }
        if (confirmationLookback) {
          const observation = deriveOiSurgeObservation({
            symbol,
            horizon: horizon.horizon,
            current: asSnapshot(confirmationPoint),
            prior: asSnapshot(confirmationLookback),
            displayScale: deps.displayScale(symbol),
            policy,
          });
          if (observation) confirmationObservations.push(observation);
        }
      }

      const detection = selectPersistentOiSurgeDetection(
        currentObservations,
        confirmationObservations,
        policy.confirmationMaxGapMs,
      );
      if (!detection) continue;
      report.confirmed += 1;
      const event = eventOf(detection, deps.sector(symbol), now);
      const reservation = deps.reserve(event, policy.eventThreadMs);
      report[reservation.kind] += 1;
      deps.onReserved?.(event, reservation);
    } catch {
      report.errors += 1;
    }
  }

  return report;
}

export interface OiSurgeTickReport {
  scan: OiSurgeScanReport;
  outcomes: OiSurgeOutcomeEvaluation;
  delivery: {
    mode: OiSurgeAlertMode;
    candidates: number;
    shadowed: number;
    ineligible: number;
    duplicate: number;
    delivered: number;
    failed: number;
    unknown: number;
    errors: number;
    recovery: OiSurgeRecoverySummary;
  };
}

export interface OiSurgeSchedulerState {
  inFlight: boolean;
  lastStartedAt: number | null;
  lastSuccessfulAt: number | null;
  lastError: string | null;
  lastReport: OiSurgeTickReport | null;
}

export interface OiSurgeScheduler {
  kick(): Promise<OiSurgeTickReport> | null;
  getState(): OiSurgeSchedulerState;
}

export function createOiSurgeScheduler(
  run: () => Promise<OiSurgeTickReport> | OiSurgeTickReport,
  minimumIntervalMs = 60_000,
  now: () => number = Date.now,
): OiSurgeScheduler {
  let inFlight: Promise<OiSurgeTickReport> | null = null;
  let lastStartedAt: number | null = null;
  let lastSuccessfulAt: number | null = null;
  let lastError: string | null = null;
  let lastReport: OiSurgeTickReport | null = null;

  return {
    kick() {
      if (inFlight) return inFlight;
      const startedAt = now();
      if (lastStartedAt != null && startedAt - lastStartedAt < minimumIntervalMs) return null;
      lastStartedAt = startedAt;
      try {
        inFlight = Promise.resolve(run())
          .then((report) => {
            lastSuccessfulAt = startedAt;
            lastError = null;
            lastReport = report;
            return report;
          })
          .catch((error: unknown) => {
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
          })
          .finally(() => {
            inFlight = null;
          });
        return inFlight;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        inFlight = null;
        throw error;
      }
    },
    getState() {
      return {
        inFlight: inFlight != null,
        lastStartedAt,
        lastSuccessfulAt,
        lastError,
        lastReport,
      };
    },
  };
}

export async function runOiSurgeTick(): Promise<OiSurgeTickReport> {
  const candidateIds = new Set<number>();
  const scan = scanOiSurges({
    ...defaultScannerDeps,
    onReserved: (event, reservation) => {
      const candidateId = selectOiSurgePilotCandidate(event, reservation);
      if (candidateId != null) candidateIds.add(candidateId);
    },
  });
  const outcomes = evaluateOiSurgeOutcomes();
  const recovery = await resumeOiSurgeDeliveries();
  const delivery: OiSurgeTickReport["delivery"] = {
    mode: recovery.mode,
    candidates: candidateIds.size,
    shadowed: 0,
    ineligible: 0,
    duplicate: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
    errors: 0,
    recovery,
  };
  for (const eventId of candidateIds) {
    const event = getOiSurgeEvent(eventId);
    if (!event) {
      delivery.errors += 1;
      continue;
    }
    const result = await deliverExtremeOiSurgeEvent(event);
    if (result === "shadow") delivery.shadowed += 1;
    else if (result === "ledger_error") delivery.errors += 1;
    else delivery[result] += 1;
  }
  return { scan, outcomes, delivery };
}

const defaultScheduler = createOiSurgeScheduler(runOiSurgeTick);

export function startOiSurgeTick(): Promise<OiSurgeTickReport> | null {
  return defaultScheduler.kick();
}

export function getOiSurgeSchedulerHealth(): OiSurgeSchedulerState {
  return defaultScheduler.getState();
}

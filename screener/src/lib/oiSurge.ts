export type OiSurgeHorizon = "5m" | "15m" | "1h" | "4h";
export type OiSurgeLane = "relative" | "systemic";
export type OiSurgeSeverity = "high" | "extreme";
export type OiSurgeAlertMode = "shadow" | "extreme-pilot";
export type OiSurgeQuadrant =
  | "expanding_up"
  | "expanding_down"
  | "expanding_flat"
  | "contracting_up"
  | "contracting_down"
  | "contracting_flat";

export interface OiSurgeSnapshot {
  ts: number;
  mark: number;
  oi: number | null;
  funding: number | null;
  volume: number | null;
}

interface OiSurgeLaneThreshold {
  minOiCoinsChangePct: number;
  minQuantityDeltaUsd: number;
}

interface OiSurgeSeverityThresholds {
  relative: OiSurgeLaneThreshold;
  systemic: OiSurgeLaneThreshold;
}

export interface OiSurgeHorizonPolicy {
  lookbackMs: number;
  toleranceMs: number;
  high: OiSurgeSeverityThresholds;
  extreme: OiSurgeSeverityThresholds;
}

export interface OiSurgePolicy {
  mode: "shadow";
  minReferenceOiUsd: number;
  minCurrentVolume24hUsd: number;
  currentSnapshotMaxAgeMs: number;
  priceDeadZonePct: number;
  confirmationOffsetMs: number;
  confirmationMaxGapMs: number;
  eventThreadMs: number;
  horizons: Record<OiSurgeHorizon, OiSurgeHorizonPolicy>;
}

export const OI_SURGE_POLICY_VERSION = "oi-surge-shadow-v1";

export const OI_SURGE_HORIZONS: readonly OiSurgeHorizon[] = ["5m", "15m", "1h", "4h"];

export const DEFAULT_OI_SURGE_POLICY: OiSurgePolicy = {
  mode: "shadow",
  minReferenceOiUsd: 10_000_000,
  minCurrentVolume24hUsd: 5_000_000,
  currentSnapshotMaxAgeMs: 2 * 60_000,
  priceDeadZonePct: 0.1,
  confirmationOffsetMs: 60_000,
  confirmationMaxGapMs: 2 * 60_000,
  eventThreadMs: 4 * 60 * 60_000,
  horizons: {
    "5m": {
      lookbackMs: 5 * 60_000,
      toleranceMs: 2 * 60_000,
      high: {
        relative: { minOiCoinsChangePct: 5, minQuantityDeltaUsd: 5_000_000 },
        systemic: { minOiCoinsChangePct: 1.5, minQuantityDeltaUsd: 20_000_000 },
      },
      extreme: {
        relative: { minOiCoinsChangePct: 7.5, minQuantityDeltaUsd: 10_000_000 },
        systemic: { minOiCoinsChangePct: 1.5, minQuantityDeltaUsd: 40_000_000 },
      },
    },
    "15m": {
      lookbackMs: 15 * 60_000,
      toleranceMs: 3 * 60_000,
      high: {
        relative: { minOiCoinsChangePct: 7.5, minQuantityDeltaUsd: 5_000_000 },
        systemic: { minOiCoinsChangePct: 2, minQuantityDeltaUsd: 25_000_000 },
      },
      extreme: {
        relative: { minOiCoinsChangePct: 10, minQuantityDeltaUsd: 10_000_000 },
        systemic: { minOiCoinsChangePct: 2, minQuantityDeltaUsd: 50_000_000 },
      },
    },
    "1h": {
      lookbackMs: 60 * 60_000,
      toleranceMs: 5 * 60_000,
      high: {
        relative: { minOiCoinsChangePct: 15, minQuantityDeltaUsd: 10_000_000 },
        systemic: { minOiCoinsChangePct: 4, minQuantityDeltaUsd: 50_000_000 },
      },
      extreme: {
        relative: { minOiCoinsChangePct: 20, minQuantityDeltaUsd: 20_000_000 },
        systemic: { minOiCoinsChangePct: 4, minQuantityDeltaUsd: 100_000_000 },
      },
    },
    "4h": {
      lookbackMs: 4 * 60 * 60_000,
      toleranceMs: 8 * 60_000,
      high: {
        relative: { minOiCoinsChangePct: 30, minQuantityDeltaUsd: 20_000_000 },
        systemic: { minOiCoinsChangePct: 8, minQuantityDeltaUsd: 100_000_000 },
      },
      extreme: {
        relative: { minOiCoinsChangePct: 40, minQuantityDeltaUsd: 40_000_000 },
        systemic: { minOiCoinsChangePct: 8, minQuantityDeltaUsd: 200_000_000 },
      },
    },
  },
};

export interface OiSurgeObservation {
  symbol: string;
  horizon: OiSurgeHorizon;
  currentTs: number;
  priorTs: number;
  currentMark: number;
  priorMark: number;
  currentOiCoins: number;
  priorOiCoins: number;
  currentOiUsd: number;
  priorOiUsd: number;
  oiQuantityDeltaUsd: number;
  oiUsdDelta: number;
  oiCoinsChangePct: number;
  priceChangePct: number;
  fundingHourly: number | null;
  volume24h: number;
  quadrant: OiSurgeQuadrant;
  severity: OiSurgeSeverity | null;
  lanes: OiSurgeLane[];
}

export interface OiSurgeDetection {
  symbol: string;
  detectedAt: number;
  severity: OiSurgeSeverity;
  horizons: OiSurgeHorizon[];
  lanes: OiSurgeLane[];
  primary: OiSurgeObservation;
  observations: OiSurgeObservation[];
}

export interface OiSurgePublicOutcome {
  horizon: "1h" | "4h" | "24h";
  status: "observed" | "missing" | "untrackable";
  targetAt: number;
  snapshotAt: number | null;
  mark: number | null;
  returnPct: number | null;
  absReturnPct: number | null;
  highReturnPct: number | null;
  lowReturnPct: number | null;
}

export interface OiSurgePublicEvent {
  id: number;
  policyVersion: string;
  source: string;
  mode: "shadow";
  symbol: string;
  sector: string;
  startedAt: number;
  lastDetectedAt: number;
  severity: OiSurgeSeverity;
  primaryHorizon: OiSurgeHorizon;
  entryMark: number;
  entryOiUsd: number;
  latestQuadrant: Extract<OiSurgeQuadrant, "expanding_up" | "expanding_down" | "expanding_flat">;
  maxOiCoinsChangePct: number;
  maxQuantityDeltaUsd: number;
  latestPriceChangePct: number;
  volume24h: number;
  fundingHourly: number | null;
  horizons: OiSurgeHorizon[];
  lanes: OiSurgeLane[];
  outcomes: OiSurgePublicOutcome[];
}

export interface OiSurgePublicPayload {
  policyVersion: string;
  mode: "shadow";
  alertMode: OiSurgeAlertMode;
  windowHours: number;
  summary: { total: number; high: number; extreme: number };
  events: OiSurgePublicEvent[];
}

export function latestOiSurgeEventsBySymbol<
  T extends { symbol: string; lastDetectedAt: number },
>(events: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const event of events) {
    const current = latest.get(event.symbol);
    if (!current || event.lastDetectedAt > current.lastDetectedAt) latest.set(event.symbol, event);
  }
  return latest;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function qualifies(
  observation: Pick<OiSurgeObservation, "oiCoinsChangePct" | "oiQuantityDeltaUsd">,
  threshold: OiSurgeLaneThreshold,
): boolean {
  return observation.oiCoinsChangePct >= threshold.minOiCoinsChangePct
    && observation.oiQuantityDeltaUsd >= threshold.minQuantityDeltaUsd;
}

function classifyQuadrant(
  oiCoinsDelta: number,
  priceChangePct: number,
  deadZonePct: number,
): OiSurgeQuadrant {
  const oiState = oiCoinsDelta >= 0 ? "expanding" : "contracting";
  const priceState = priceChangePct > deadZonePct
    ? "up"
    : priceChangePct < -deadZonePct
      ? "down"
      : "flat";
  return `${oiState}_${priceState}` as OiSurgeQuadrant;
}

function classifySeverityAndLanes(
  observation: Pick<OiSurgeObservation, "oiCoinsChangePct" | "oiQuantityDeltaUsd">,
  policy: OiSurgeHorizonPolicy,
): { severity: OiSurgeSeverity | null; lanes: OiSurgeLane[] } {
  if (observation.oiCoinsChangePct <= 0 || observation.oiQuantityDeltaUsd <= 0) {
    return { severity: null, lanes: [] };
  }

  const extremeLanes = (["relative", "systemic"] as const).filter((lane) =>
    qualifies(observation, policy.extreme[lane])
  );
  if (extremeLanes.length > 0) return { severity: "extreme", lanes: extremeLanes };

  const highLanes = (["relative", "systemic"] as const).filter((lane) =>
    qualifies(observation, policy.high[lane])
  );
  return highLanes.length > 0
    ? { severity: "high", lanes: highLanes }
    : { severity: null, lanes: [] };
}

export function deriveOiSurgeObservation(input: {
  symbol: string;
  horizon: OiSurgeHorizon;
  current: OiSurgeSnapshot;
  prior: OiSurgeSnapshot;
  displayScale: number;
  policy?: OiSurgePolicy;
}): OiSurgeObservation | null {
  const policy = input.policy ?? DEFAULT_OI_SURGE_POLICY;
  const horizonPolicy = policy.horizons[input.horizon];
  const { current, prior } = input;
  if (
    input.symbol.trim() === ""
    || !isFinitePositive(input.displayScale)
    || !Number.isFinite(current.ts)
    || !Number.isFinite(prior.ts)
    || current.ts <= prior.ts
    || !isFinitePositive(current.mark)
    || !isFinitePositive(prior.mark)
    || current.oi == null
    || prior.oi == null
    || !Number.isFinite(current.oi)
    || !Number.isFinite(prior.oi)
    || current.oi < 0
    || prior.oi <= 0
    || current.volume == null
    || !Number.isFinite(current.volume)
    || current.volume < 0
  ) {
    return null;
  }
  const observedLookbackMs = current.ts - prior.ts;
  if (Math.abs(observedLookbackMs - horizonPolicy.lookbackMs) > horizonPolicy.toleranceMs) {
    return null;
  }

  const currentRawMark = current.mark / input.displayScale;
  const priorRawMark = prior.mark / input.displayScale;
  if (!isFinitePositive(currentRawMark) || !isFinitePositive(priorRawMark)) return null;

  const currentOiUsd = current.oi * currentRawMark;
  const priorOiUsd = prior.oi * priorRawMark;
  const oiCoinsDelta = current.oi - prior.oi;
  const oiQuantityDeltaUsd = oiCoinsDelta * priorRawMark;
  const oiCoinsChangePct = (oiCoinsDelta / prior.oi) * 100;
  const priceChangePct = ((current.mark - prior.mark) / prior.mark) * 100;

  const base: Omit<OiSurgeObservation, "severity" | "lanes"> = {
    symbol: input.symbol,
    horizon: input.horizon,
    currentTs: current.ts,
    priorTs: prior.ts,
    currentMark: current.mark,
    priorMark: prior.mark,
    currentOiCoins: current.oi,
    priorOiCoins: prior.oi,
    currentOiUsd,
    priorOiUsd,
    oiQuantityDeltaUsd,
    oiUsdDelta: currentOiUsd - priorOiUsd,
    oiCoinsChangePct,
    priceChangePct,
    fundingHourly: current.funding != null && Number.isFinite(current.funding) ? current.funding : null,
    volume24h: current.volume,
    quadrant: classifyQuadrant(oiCoinsDelta, priceChangePct, policy.priceDeadZonePct),
  };

  const liquid = Math.max(currentOiUsd, priorOiUsd) >= policy.minReferenceOiUsd
    && current.volume >= policy.minCurrentVolume24hUsd;
  const classification = liquid
    ? classifySeverityAndLanes(base, horizonPolicy)
    : { severity: null, lanes: [] as OiSurgeLane[] };
  return { ...base, ...classification };
}

function severityRank(severity: OiSurgeSeverity): number {
  return severity === "extreme" ? 2 : 1;
}

function horizonRank(horizon: OiSurgeHorizon): number {
  return OI_SURGE_HORIZONS.indexOf(horizon);
}

export function selectPersistentOiSurgeDetection(
  current: OiSurgeObservation[],
  previous: OiSurgeObservation[],
  maxConfirmationGapMs: number = DEFAULT_OI_SURGE_POLICY.confirmationMaxGapMs,
): OiSurgeDetection | null {
  if (!Number.isFinite(maxConfirmationGapMs) || maxConfirmationGapMs <= 0) return null;
  const qualified = current.filter(
    (observation): observation is OiSurgeObservation & { severity: OiSurgeSeverity } =>
      observation.severity !== null
  );
  if (qualified.length === 0) return null;

  const symbols = new Set(qualified.map((observation) => observation.symbol));
  if (symbols.size !== 1) return null;
  const symbol = qualified[0].symbol;
  const previousByHorizon = new Map(
    previous
      .filter((observation) => observation.symbol === symbol && observation.severity !== null)
      .map((observation) => [observation.horizon, observation]),
  );
  const confirmed = qualified.filter((observation) => {
    const confirmation = previousByHorizon.get(observation.horizon);
    if (!confirmation) return false;
    const gap = observation.currentTs - confirmation.currentTs;
    return gap > 0 && gap <= maxConfirmationGapMs;
  });
  if (confirmed.length === 0) return null;

  confirmed.sort((left, right) => horizonRank(left.horizon) - horizonRank(right.horizon));
  const primary = [...confirmed].sort((left, right) =>
    severityRank(right.severity as OiSurgeSeverity) - severityRank(left.severity as OiSurgeSeverity)
    || Math.abs(right.oiQuantityDeltaUsd) - Math.abs(left.oiQuantityDeltaUsd)
    || horizonRank(left.horizon) - horizonRank(right.horizon)
  )[0];
  const severity = confirmed.some((observation) => observation.severity === "extreme")
    ? "extreme"
    : "high";
  const lanes = (["relative", "systemic"] as const).filter((lane) =>
    confirmed.some((observation) => observation.lanes.includes(lane))
  );

  return {
    symbol,
    detectedAt: Math.max(...confirmed.map((observation) => observation.currentTs)),
    severity,
    horizons: confirmed.map((observation) => observation.horizon),
    lanes,
    primary,
    observations: confirmed,
  };
}

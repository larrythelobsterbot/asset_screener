export type AlertDirection = "long" | "short";
export type AlertOutcomeStatus =
  | "open"
  | "target"
  | "stop"
  | "ambiguous"
  | "expired"
  | "untrackable";

export interface AlertPriceObservation {
  ts: number;
  high?: number | null;
  low?: number | null;
  mark?: number | null;
}

export interface AlertCandle {
  ts: number;
  high?: number | null;
  low?: number | null;
  close?: number | null;
}

export interface AlertOutcomeInput {
  direction: AlertDirection;
  entry?: number | null;
  stop?: number | null;
  target?: number | null;
  alertAt: number;
  now: number;
  snapshots: readonly AlertPriceObservation[];
  candles: readonly AlertCandle[];
  expiresAt?: number;
  existingOutcome?: AlertOutcomeResult;
}

export interface AlertOutcomeResult {
  status: AlertOutcomeStatus;
  resolvedAt?: number;
  exitPrice?: number;
  rMultiple?: number;
}

const HOUR_MS = 60 * 60 * 1_000;
const EXPIRY_MS = 48 * HOUR_MS;

export function firstFullyPostAlertCandleStart(alertAt: number): number {
  const hourStart = Math.floor(alertAt / HOUR_MS) * HOUR_MS;
  return alertAt === hourStart ? hourStart : hourStart + HOUR_MS;
}

type Evidence = {
  kind: "observation" | "candle";
  ts: number;
  high?: number | null;
  low?: number | null;
  mark?: number | null;
  close?: number | null;
};

const validPrice = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const validGeometry = (direction: AlertDirection, entry: number, stop: number, target: number): boolean =>
  direction === "long"
    ? stop < entry && entry < target
    : target < entry && entry < stop;

const terminal = (status: AlertOutcomeStatus): boolean => status !== "open";

const rMultiple = (input: AlertOutcomeInput, price: number): number | undefined => {
  if (!validPrice(input.entry) || !validPrice(input.stop)) return undefined;
  const risk = Math.abs(input.entry - input.stop);
  if (risk === 0) return undefined;
  return input.direction === "long"
    ? (price - input.entry) / risk
    : (input.entry - price) / risk;
};

const resultFor = (
  status: AlertOutcomeStatus,
  resolvedAt?: number,
  exitPrice?: number,
  r?: number,
): AlertOutcomeResult => {
  const result: AlertOutcomeResult = { status };
  if (resolvedAt !== undefined) result.resolvedAt = resolvedAt;
  if (exitPrice !== undefined) result.exitPrice = exitPrice;
  if (r !== undefined && Number.isFinite(r)) result.rMultiple = r;
  return result;
};

export function evaluateAlertOutcome(input: AlertOutcomeInput): AlertOutcomeResult {
  if (input.existingOutcome && terminal(input.existingOutcome.status)) {
    return { ...input.existingOutcome };
  }

  if (!validPrice(input.entry) || !validPrice(input.stop) || !validPrice(input.target)) {
    return resultFor("untrackable");
  }
  if (!validGeometry(input.direction, input.entry, input.stop, input.target)) {
    return resultFor("untrackable");
  }

  const openingCandleStart = firstFullyPostAlertCandleStart(input.alertAt);
  const expiry = input.expiresAt ?? input.alertAt + EXPIRY_MS;
  const evidenceThrough = Math.min(input.now, expiry);
  const observations: Evidence[] = [
    ...input.snapshots
      .filter((observation) => observation.ts > input.alertAt && observation.ts <= evidenceThrough)
      .map((observation): Evidence => ({ kind: "observation", ...observation })),
    ...input.candles
      .filter((candle) => candle.ts >= openingCandleStart && candle.ts <= evidenceThrough)
      .map((candle): Evidence => ({ kind: "candle", ...candle })),
  ].sort((a, b) => a.ts - b.ts);

  let freshestMark: { ts: number; price: number } | undefined;
  for (let index = 0; index < observations.length;) {
    const ts = observations[index].ts;
    let high: number | undefined;
    let low: number | undefined;
    let observedMark: number | undefined;
    let candleClose: number | undefined;

    while (index < observations.length && observations[index].ts === ts) {
      const evidence = observations[index];
      if (validPrice(evidence.high)) high = high === undefined ? evidence.high : Math.max(high, evidence.high);
      if (validPrice(evidence.low)) low = low === undefined ? evidence.low : Math.min(low, evidence.low);
      if (validPrice(evidence.mark)) observedMark = evidence.mark;
      if (validPrice(evidence.close)) candleClose = evidence.close;
      index += 1;
    }

    const hitStop = input.direction === "long" ? low !== undefined && low <= input.stop : high !== undefined && high >= input.stop;
    const hitTarget = input.direction === "long" ? high !== undefined && high >= input.target : low !== undefined && low <= input.target;

    if (hitStop && hitTarget) return resultFor("ambiguous", ts);
    if (hitStop) return resultFor("stop", ts, input.stop, -1);
    if (hitTarget) return resultFor("target", ts, input.target, rMultiple(input, input.target));

    const mark = observedMark ?? candleClose;
    if (mark !== undefined) freshestMark = { ts, price: mark };
  }

  if (input.now >= expiry) {
    const mark = freshestMark;
    return mark
      ? resultFor("expired", mark.ts, mark.price, rMultiple(input, mark.price))
      : resultFor("untrackable", expiry);
  }
  return resultFor("open");
}

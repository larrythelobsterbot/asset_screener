export type PositioningStatus = "observed" | "unavailable" | "stale";
export type PositioningDirection = "up" | "down" | "flat";
export type PositioningQuadrant =
  | "price_up_contracts_up"
  | "price_up_contracts_down"
  | "price_up_contracts_flat"
  | "price_down_contracts_up"
  | "price_down_contracts_down"
  | "price_down_contracts_flat"
  | "price_flat_contracts_up"
  | "price_flat_contracts_down"
  | "price_flat_contracts_flat"
  | "unavailable";

export interface PositioningPoint {
  ts: number;
  mark: number;
  oiCoins: number | null;
}

export interface PositioningObservationInput {
  symbol: string;
  horizonMs: number;
  toleranceMs: number;
  displayScale: number;
  current: PositioningPoint;
  prior: PositioningPoint | null;
  now: number;
  currentMaxAgeMs: number;
  priceDeadZonePct?: number;
  contractDeadZonePct?: number;
}

export interface PositioningObservation {
  symbol: string;
  status: PositioningStatus;
  statusReason: string | null;
  horizonMs: number;
  currentTs: number | null;
  priorTs: number | null;
  currentAgeMs: number | null;
  historicalAgeMs: number | null;
  priceChangePct: number | null;
  oiCoinsChangePct: number | null;
  /** Contract quantity effect, valued at prior raw quote price. */
  oiQuantityDeltaUsd: number | null;
  /** Mark-to-market USD OI delta, using each row's own raw price. */
  oiUsdDelta: number | null;
  priceDirection: PositioningDirection | null;
  contractDirection: PositioningDirection | null;
  quadrant: PositioningQuadrant;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function direction(value: number, deadZonePct: number): PositioningDirection {
  if (value > deadZonePct) return "up";
  if (value < -deadZonePct) return "down";
  return "flat";
}

function safeDifference(left: number, right: number): number | null {
  const difference = left - right;
  return finite(difference) ? difference : null;
}

function unavailable(
  input: PositioningObservationInput,
  status: PositioningStatus,
  reason: string,
): PositioningObservation {
  return {
    symbol: input.symbol,
    status,
    statusReason: reason,
    horizonMs: input.horizonMs,
    currentTs: finite(input.current.ts) ? input.current.ts : null,
    priorTs: input.prior && finite(input.prior.ts) ? input.prior.ts : null,
    currentAgeMs: finite(input.current.ts) && finite(input.now)
      ? (() => {
        const age = safeDifference(input.now, input.current.ts);
        return age == null ? null : Math.max(0, age);
      })()
      : null,
    historicalAgeMs: input.prior && finite(input.current.ts) && finite(input.prior.ts)
      ? safeDifference(input.current.ts, input.prior.ts)
      : null,
    priceChangePct: null,
    oiCoinsChangePct: null,
    oiQuantityDeltaUsd: null,
    oiUsdDelta: null,
    priceDirection: null,
    contractDirection: null,
    quadrant: "unavailable",
  };
}

/**
 * Pair current/prior marks and contract quantities without inventing data.
 * Marks are display-scaled; all USD calculations use raw quote prices.
 */
export function derivePositioningObservation(
  input: PositioningObservationInput,
): PositioningObservation {
  const { current, prior } = input;
  if (
    input.symbol.trim() === ""
    || !finite(input.now)
    || !finite(input.horizonMs)
    || input.horizonMs <= 0
    || !finite(input.toleranceMs)
    || input.toleranceMs < 0
    || !finite(input.displayScale)
    || input.displayScale <= 0
    || !finite(input.currentMaxAgeMs)
    || input.currentMaxAgeMs < 0
    || (input.priceDeadZonePct !== undefined
      && (!finite(input.priceDeadZonePct) || input.priceDeadZonePct < 0))
    || (input.contractDeadZonePct !== undefined
      && (!finite(input.contractDeadZonePct) || input.contractDeadZonePct < 0))
    || !finite(current.ts)
    || !finite(current.mark)
    || current.mark <= 0
    || current.oiCoins == null
    || !finite(current.oiCoins)
    || current.oiCoins < 0
  ) {
    return unavailable(input, "unavailable", "invalid current observation");
  }
  if (current.ts > input.now) return unavailable(input, "unavailable", "future current observation");
  if (input.now - current.ts > input.currentMaxAgeMs) {
    return unavailable(input, "stale", "current observation is stale");
  }
  if (!prior) return unavailable(input, "unavailable", "historical observation missing");
  if (
    !finite(prior.ts)
    || !finite(prior.mark)
    || prior.mark <= 0
    || prior.oiCoins == null
    || !finite(prior.oiCoins)
    || prior.oiCoins <= 0
    || prior.ts >= current.ts
  ) {
    return unavailable(input, "unavailable", "historical observation invalid");
  }
  const historicalAgeMs = safeDifference(current.ts, prior.ts);
  if (historicalAgeMs == null) {
    return unavailable(input, "unavailable", "historical observation arithmetic overflow");
  }
  if (Math.abs(historicalAgeMs - input.horizonMs) > input.toleranceMs) {
    return unavailable(input, "stale", "historical observation outside bounded horizon");
  }

  const scale = input.displayScale;
  const currentRaw = current.mark / scale;
  const priorRaw = prior.mark / scale;
  const oiCoinsDelta = current.oiCoins - prior.oiCoins;
  const priceChangePct = ((current.mark - prior.mark) / prior.mark) * 100;
  const oiCoinsChangePct = (oiCoinsDelta / prior.oiCoins) * 100;
  const oiQuantityDeltaUsd = oiCoinsDelta * priorRaw;
  const oiUsdDelta = current.oiCoins * currentRaw - prior.oiCoins * priorRaw;
  if (
    !finite(currentRaw)
    || !finite(priorRaw)
    || !finite(oiCoinsDelta)
    || !finite(priceChangePct)
    || !finite(oiCoinsChangePct)
    || !finite(oiQuantityDeltaUsd)
    || !finite(oiUsdDelta)
  ) {
    return unavailable(input, "unavailable", "derived metric arithmetic overflow");
  }
  const deadZone = input.priceDeadZonePct ?? 0.1;
  const contractDeadZone = input.contractDeadZonePct ?? 0.1;
  const priceDirection = direction(priceChangePct, deadZone);
  const contractDirection = direction(oiCoinsChangePct, contractDeadZone);

  return {
    symbol: input.symbol,
    status: "observed",
    statusReason: null,
    horizonMs: input.horizonMs,
    currentTs: current.ts,
    priorTs: prior.ts,
    currentAgeMs: Math.max(0, input.now - current.ts),
    historicalAgeMs,
    priceChangePct,
    oiCoinsChangePct,
    oiQuantityDeltaUsd,
    oiUsdDelta,
    priceDirection,
    contractDirection,
    quadrant: `price_${priceDirection}_contracts_${contractDirection}` as PositioningQuadrant,
  };
}

export type PayloadFreshness = "fresh" | "stale" | "expired" | "invalid";

export function assessPayloadFreshness(
  generatedAt: number,
  now: number,
  freshForMs: number,
  staleForMs: number,
): { status: PayloadFreshness; ageMs: number | null } {
  if (
    !finite(generatedAt)
    || !finite(now)
    || generatedAt > now
    || !finite(freshForMs)
    || freshForMs < 0
    || !finite(staleForMs)
    || staleForMs < freshForMs
  ) return { status: "invalid", ageMs: null };
  const ageMs = now - generatedAt;
  if (ageMs <= freshForMs) return { status: "fresh", ageMs };
  if (ageMs <= staleForMs) return { status: "stale", ageMs };
  return { status: "expired", ageMs };
}

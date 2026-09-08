import { rawPriceOf } from "./priceScale";
import type { MarketContract } from "./marketContract";

export const ROTATION_WINDOWS = ["1h", "8h", "24h", "48h", "7d"] as const;
export type RotationWindow = (typeof ROTATION_WINDOWS)[number];
export const ROTATION_MAX_STALE_MS = 10 * 60_000;
export type RotationMarketKind = "native" | "hip3";
export type RotationMetricStatus = "observed" | "partial" | "unavailable";
export type RotationCellStatus = "observed" | "unavailable";

/** Alias keeps rotation payloads aligned with Track A's canonical identity. */
export type RotationMarketContract = MarketContract;

export interface RotationSnapshotPoint {
  ts: number;
  /** Display-unit mark. `rawPriceOf` is applied before valuing coin quantities. */
  mark: number;
  /** Coin-denominated OI. Zero is valid evidence; null is missing evidence. */
  oi: number | null;
  /** Hourly funding rate as a decimal, when provided by the source. */
  funding: number | null;
}

export interface RotationVolumeEstimate {
  status: "estimated" | "unavailable";
  coverage: "complete" | "gapped" | "fractional" | "missing";
  bars: number;
  fromTs: number | null;
  toTs: number | null;
  notionalUsdEstimate: number | null;
  provenance: string;
}

export interface RotationMetric {
  window: RotationWindow;
  status: RotationMetricStatus;
  currentTs: number | null;
  priorTs: number | null;
  pricePct: number | null;
  priceStatus: RotationCellStatus;
  oiCoinPct: number | null;
  oiStatus: RotationCellStatus;
  /** (current OI coins - prior OI coins) × prior raw price. */
  quantityEffectUsd: number | null;
  quantityEffectStatus: RotationCellStatus;
  /** Current OI USD - prior OI USD, each valued at its own raw mark. */
  oiUsdDelta: number | null;
  oiUsdDeltaStatus: RotationCellStatus;
  volume: RotationVolumeEstimate;
  /** Current hourly funding rate held constant over this horizon. */
  fundingProjectionPct: number | null;
  fundingProjectionStatus: RotationCellStatus;
  provenance: string;
}

export interface RotationRow {
  symbol: string;
  name: string;
  contract: RotationMarketContract;
  current: RotationSnapshotPoint;
  volume24h: number;
  windows: Record<RotationWindow, RotationMetric>;
}

export interface RotationPayload {
  generatedAt: number;
  metadata: {
    source: "hyperliquid";
    snapshotStore: "price_snapshots";
    historyIdentity: "legacy-symbol";
    currentMaxAgeMs: number;
    currentSourceAgeMs: number;
    historicalToleranceMs: number;
    candleInterval: "1h";
    stale: boolean;
    cacheAgeMs: number;
    warming: boolean;
    partialSources: string[];
  };
  rows: RotationRow[];
}

const WINDOW_MS: Record<RotationWindow, number> = {
  "1h": 3_600_000,
  "8h": 8 * 3_600_000,
  "24h": 24 * 3_600_000,
  "48h": 48 * 3_600_000,
  "7d": 7 * 86_400_000,
};

export function rotationWindowMs(window: RotationWindow): number {
  return WINDOW_MS[window];
}

function finitePositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

function finiteResult(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function pairedSnapshotsReady(
  window: RotationWindow,
  current: RotationSnapshotPoint | null,
  prior: RotationSnapshotPoint | null,
): boolean {
  if (!current || !prior || !finiteNonNegative(current.ts) || !finiteNonNegative(prior.ts)) return false;
  // snapshotFullAtBounded is deliberately tolerant around the target. Keep
  // the same bounded-pair invariant in this pure helper so forged or stale
  // points cannot produce apparently observed changes.
  return prior.ts < current.ts
    && Math.abs((current.ts - prior.ts) - WINDOW_MS[window]) <= 10 * 60_000;
}

function unavailableVolume(coverage: RotationVolumeEstimate["coverage"], provenance: string): RotationVolumeEstimate {
  return {
    status: "unavailable",
    coverage,
    bars: 0,
    fromTs: null,
    toTs: null,
    notionalUsdEstimate: null,
    provenance,
  };
}

export function buildRotationMetric(
  window: RotationWindow,
  current: RotationSnapshotPoint | null,
  prior: RotationSnapshotPoint | null,
  symbol: string,
  displayScale = 1,
  volume: RotationVolumeEstimate = unavailableVolume("missing", "No contiguous completed 1h candle coverage"),
): RotationMetric {
  const currentTs = current && finiteNonNegative(current.ts) ? current.ts : null;
  const priorTs = prior && finiteNonNegative(prior.ts) ? prior.ts : null;
  const pairReady = pairedSnapshotsReady(window, current, prior);
  const priceReady = Boolean(pairReady && finitePositive(current!.mark) && finitePositive(prior!.mark));
  const priceDelta = priceReady ? finiteResult(current!.mark - prior!.mark) : null;
  const pricePct = priceDelta != null ? finiteResult((priceDelta / prior!.mark) * 100) : null;
  const priceStatus: RotationCellStatus = pricePct != null ? "observed" : "unavailable";

  const oiReady = Boolean(
    pairReady && finiteNonNegative(current!.oi) && finiteNonNegative(prior!.oi),
  );
  const currentOi = oiReady ? current!.oi! : null;
  const priorOi = oiReady ? prior!.oi! : null;
  const oiDelta = oiReady ? finiteResult(currentOi! - priorOi!) : null;
  const oiCoinPct = oiDelta != null && priorOi! > 0
    ? finiteResult((oiDelta / priorOi!) * 100)
    : null;
  const oiStatus: RotationCellStatus = oiCoinPct != null ? "observed" : "unavailable";
  const rawPriorPrice = prior && finitePositive(prior.mark) ? rawPriceOf(symbol, prior.mark) : null;
  const quantityEffectUsd = oiReady && finitePositive(rawPriorPrice)
    ? finiteResult((currentOi! - priorOi!) * rawPriorPrice)
    : null;
  // A zero prior OI is still a valid quantity observation, even though its
  // percentage denominator is unavailable.
  const quantityEffectStatus: RotationCellStatus = quantityEffectUsd != null ? "observed" : "unavailable";
  const rawCurrentPrice = current && finitePositive(current.mark) ? rawPriceOf(symbol, current.mark) : null;
  const oiUsdDelta = oiReady && finitePositive(rawCurrentPrice) && finitePositive(rawPriorPrice)
    ? finiteResult(currentOi! * rawCurrentPrice - priorOi! * rawPriorPrice)
    : null;
  const oiUsdDeltaStatus: RotationCellStatus = oiUsdDelta != null ? "observed" : "unavailable";

  const fundingProjectionPct = current && pairReady && current.funding != null && Number.isFinite(current.funding)
    ? finiteResult(current.funding * (WINDOW_MS[window] / 3_600_000) * 100)
    : null;
  const fundingProjectionStatus: RotationCellStatus = fundingProjectionPct != null ? "observed" : "unavailable";
  const status: RotationMetricStatus = priceStatus === "observed" && oiStatus === "observed"
    ? "observed"
    : priceStatus === "observed" || quantityEffectStatus === "observed"
      ? "partial"
      : "unavailable";

  return {
    window,
    status,
    currentTs,
    priorTs,
    pricePct,
    priceStatus,
    oiCoinPct,
    oiStatus,
    quantityEffectUsd,
    quantityEffectStatus,
    oiUsdDelta,
    oiUsdDeltaStatus,
    volume,
    fundingProjectionPct,
    fundingProjectionStatus,
    provenance: `paired price/OI snapshots; ${symbol} display scale ${displayScale} via rawPriceOf`,
  };
}

export interface CandleVolumeInput {
  t: number;
  open: number;
  close: number;
  volumeBase: number;
}

/**
 * Estimate notional from genuine completed 1h candles only. The estimate uses
 * base volume × the candle's representative RAW price; it is never a sum of
 * rolling 24h values and is deliberately labeled as an estimate.
 */
export function estimateCandleVolume(
  candles: CandleVolumeInput[],
  fromTs: number,
  toTs: number,
  intervalMs = 3_600_000,
): RotationVolumeEstimate {
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || fromTs < 0 || toTs <= fromTs
    || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return unavailableVolume("fractional", "Requested candle interval is invalid");
  }
  if (fromTs % intervalMs !== 0 || toTs % intervalMs !== 0) {
    return unavailableVolume("fractional", "Exact fractional endpoint has no complete 1h candle source window");
  }
  const expected = Math.ceil((toTs - fromTs) / intervalMs);
  if (!Number.isSafeInteger(expected) || expected <= 0 || expected > 10_000) {
    return unavailableVolume("fractional", "Requested candle interval is outside the bounded source range");
  }
  const byTime = new Map<number, CandleVolumeInput>();
  for (const candle of candles) {
    if (
      Number.isFinite(candle.t) && candle.t >= 0 && Number.isFinite(candle.open) && candle.open > 0
      && Number.isFinite(candle.close) && candle.close > 0
      && Number.isFinite(candle.volumeBase) && candle.volumeBase >= 0
      && Number.isFinite(candle.t + intervalMs)
      && candle.t >= fromTs && candle.t + intervalMs <= toTs
    ) byTime.set(candle.t, candle);
  }
  if (byTime.size !== expected) {
    return unavailableVolume(
      byTime.size === 0 ? "missing" : "gapped",
      `Unavailable: ${byTime.size}/${expected} contiguous completed 1h candles`,
    );
  }
  let notional = 0;
  for (let t = fromTs; t < toTs; t += intervalMs) {
    const candle = byTime.get(t);
    if (!candle) return unavailableVolume("gapped", `Missing completed 1h candle at ${t}`);
    const representativePrice = candle.open / 2 + candle.close / 2;
    const barNotional = candle.volumeBase * representativePrice;
    if (!Number.isFinite(representativePrice) || !Number.isFinite(barNotional)) {
      return unavailableVolume("gapped", `Invalid finite candle value at ${t}`);
    }
    notional += barNotional;
    if (!Number.isFinite(notional)) return unavailableVolume("gapped", "Candle turnover overflowed finite range");
  }
  return {
    status: "estimated",
    coverage: "complete",
    bars: expected,
    fromTs,
    toTs,
    notionalUsdEstimate: Number.isFinite(notional) ? notional : null,
    provenance: "estimated turnover: base volume × representative raw candle price; completed 1h bars",
  };
}

export type RotationSortField = "quantityEffectUsd" | "oiCoinPct" | "pricePct" | "sinceVisitPricePct" | "sinceVisitOiPct";
export type RotationSortDirection = "asc" | "desc";

function sortValue(row: RotationRow, field: RotationSortField, window: RotationWindow): number | null {
  if (field === "sinceVisitPricePct" || field === "sinceVisitOiPct") return null;
  const metric = row.windows[window];
  const value = field === "quantityEffectUsd" ? metric.quantityEffectUsd
    : field === "oiCoinPct" ? metric.oiCoinPct
      : metric.pricePct;
  return value != null && Number.isFinite(value) ? value : null;
}

export function compareRotationRows(
  a: RotationRow,
  b: RotationRow,
  sort: { field: RotationSortField; window: RotationWindow; direction?: RotationSortDirection } = { field: "quantityEffectUsd", window: "8h", direction: "desc" },
): number {
  const av = sortValue(a, sort.field, sort.window);
  const bv = sortValue(b, sort.field, sort.window);
  if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
  if (av == null) return 1;
  if (bv == null) return -1;
  return (sort.direction === "asc" ? av - bv : bv - av) || a.symbol.localeCompare(b.symbol);
}

export function identityKey(contract: RotationMarketContract): string {
  return `${contract.kind}:${contract.dex ?? "native"}:${contract.wireCoin}`;
}

export type RotationState = "up" | "down" | "flat" | "unavailable";

function stateOf(value: number | null): RotationState {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

/** Descriptive observed states only; this deliberately makes no trade claim. */
export function rotationStateTransition(metric: RotationMetric): {
  price: RotationState;
  oi: RotationState;
} {
  return { price: stateOf(metric.pricePct), oi: stateOf(metric.oiCoinPct) };
}

function finiteNullable(value: unknown, minimum = -Infinity): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= minimum);
}

function statusMatches(value: unknown, status: unknown): boolean {
  return status === "observed"
    ? typeof value === "number" && Number.isFinite(value)
    : status === "unavailable" && value === null;
}

function validContract(value: unknown): value is RotationMarketContract {
  if (typeof value !== "object" || value === null) return false;
  const contract = value as Partial<RotationMarketContract>;
  return (contract.kind === "native" || contract.kind === "hip3")
    && (contract.dex === null || typeof contract.dex === "string")
    && typeof contract.wireCoin === "string" && contract.wireCoin.length > 0
    && typeof contract.historyKey === "string" && contract.historyKey.length > 0
    && (contract.kind === "native"
      ? contract.dex === null && contract.wireCoin === contract.historyKey
      : contract.dex !== null && contract.wireCoin === `${contract.dex}:${contract.historyKey}`);
}

function validVolume(value: unknown): value is RotationVolumeEstimate {
  if (typeof value !== "object" || value === null) return false;
  const volume = value as Partial<RotationVolumeEstimate>;
  const shapeValid = (volume.status === "estimated" || volume.status === "unavailable")
    && (volume.coverage === "complete" || volume.coverage === "gapped"
      || volume.coverage === "fractional" || volume.coverage === "missing")
    && typeof volume.bars === "number" && Number.isInteger(volume.bars) && volume.bars >= 0
    && finiteNullable(volume.fromTs, 0) && finiteNullable(volume.toTs, 0)
    && finiteNullable(volume.notionalUsdEstimate, 0)
    && typeof volume.provenance === "string" && volume.provenance.length > 0;
  if (!shapeValid) return false;
  if (volume.status === "unavailable") {
    return volume.bars === 0 && volume.fromTs === null && volume.toTs === null && volume.notionalUsdEstimate === null;
  }
  const bars = volume.bars;
  const fromTs = volume.fromTs;
  const toTs = volume.toTs;
  return volume.coverage === "complete" && bars != null && bars > 0 && fromTs != null && toTs != null
    && fromTs < toTs && volume.notionalUsdEstimate != null;
}

function validMetric(
  value: unknown,
  expectedWindow: RotationWindow,
  rowCurrentTs: number,
): value is RotationMetric {
  if (typeof value !== "object" || value === null) return false;
  const metric = value as Partial<RotationMetric>;
  if (!(metric.window === expectedWindow
    && (metric.status === "observed" || metric.status === "partial" || metric.status === "unavailable")
    && metric.currentTs === rowCurrentTs && finiteNullable(metric.currentTs, 0)
    && (metric.priorTs === null || (finiteNullable(metric.priorTs, 0) && (metric.priorTs as number) <= rowCurrentTs))
    && statusMatches(metric.pricePct, metric.priceStatus)
    && (metric.priceStatus === "observed" || metric.priceStatus === "unavailable")
    && statusMatches(metric.oiCoinPct, metric.oiStatus)
    && (metric.oiStatus === "observed" || metric.oiStatus === "unavailable")
    && statusMatches(metric.quantityEffectUsd, metric.quantityEffectStatus)
    && (metric.quantityEffectStatus === "observed" || metric.quantityEffectStatus === "unavailable")
    && statusMatches(metric.oiUsdDelta, metric.oiUsdDeltaStatus)
    && (metric.oiUsdDeltaStatus === "observed" || metric.oiUsdDeltaStatus === "unavailable")
    && validVolume(metric.volume)
    && statusMatches(metric.fundingProjectionPct, metric.fundingProjectionStatus)
    && (metric.fundingProjectionStatus === "observed" || metric.fundingProjectionStatus === "unavailable")
    && typeof metric.provenance === "string" && metric.provenance.length > 0)) return false;
  const observedPriceAndOi = metric.priceStatus === "observed" && metric.oiStatus === "observed";
  const hasObservedComponent = metric.priceStatus === "observed"
    || metric.oiStatus === "observed"
    || metric.quantityEffectStatus === "observed";
  if (hasObservedComponent || metric.oiUsdDeltaStatus === "observed" || metric.fundingProjectionStatus === "observed") {
    if (metric.priorTs == null || metric.priorTs >= rowCurrentTs
      || Math.abs(rowCurrentTs - metric.priorTs - WINDOW_MS[expectedWindow]) > 10 * 60_000) return false;
  }
  return metric.status === "observed" ? observedPriceAndOi
    : metric.status === "partial" ? hasObservedComponent && !observedPriceAndOi
      : !hasObservedComponent;
}

/** Strict boundary validator used before a rotation response can reach JSX. */
export function isRotationPayload(value: unknown): value is RotationPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<RotationPayload>;
  const metadata = payload.metadata;
  const generatedAt = payload.generatedAt;
  if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt) || generatedAt < 0 || !Array.isArray(payload.rows)
    || typeof metadata !== "object" || metadata === null) return false;
  const meta = metadata as Partial<RotationPayload["metadata"]>;
  if (meta.source !== "hyperliquid" || meta.snapshotStore !== "price_snapshots"
    || meta.historyIdentity !== "legacy-symbol" || meta.candleInterval !== "1h"
    || typeof meta.stale !== "boolean" || typeof meta.warming !== "boolean"
    || typeof meta.currentMaxAgeMs !== "number" || !Number.isFinite(meta.currentMaxAgeMs) || meta.currentMaxAgeMs < 0
    || typeof meta.currentSourceAgeMs !== "number" || !Number.isFinite(meta.currentSourceAgeMs) || meta.currentSourceAgeMs < 0
    || typeof meta.historicalToleranceMs !== "number" || !Number.isFinite(meta.historicalToleranceMs) || meta.historicalToleranceMs < 0
    || typeof meta.cacheAgeMs !== "number" || !Number.isFinite(meta.cacheAgeMs) || meta.cacheAgeMs < 0
    || !Array.isArray(meta.partialSources) || !meta.partialSources.every((source) => typeof source === "string")) return false;
  if (!meta.stale && meta.currentSourceAgeMs > meta.currentMaxAgeMs) return false;
  const identities = new Set<string>();
  return payload.rows.every((valueRow) => {
    if (typeof valueRow !== "object" || valueRow === null) return false;
    const row = valueRow as Partial<RotationRow>;
    if (typeof row.symbol !== "string" || row.symbol.length === 0
      || typeof row.name !== "string" || !validContract(row.contract)
      || row.symbol !== row.contract.historyKey
      || identityKey(row.contract) !== `${row.contract.kind}:${row.contract.dex ?? "native"}:${row.contract.wireCoin}`
      || identities.has(identityKey(row.contract))
      || typeof row.current !== "object" || row.current === null
      || !Number.isFinite(row.current.ts) || row.current.ts < 0 || row.current.ts > generatedAt
      || !Number.isFinite(row.current.mark) || row.current.mark <= 0
      || !finiteNullable(row.current.oi, 0) || !finiteNullable(row.current.funding)
      || typeof row.volume24h !== "number" || !Number.isFinite(row.volume24h) || row.volume24h < 0
      || typeof row.windows !== "object" || row.windows === null) return false;
    const currentTs = row.current.ts;
    if (typeof currentTs !== "number" || !Number.isFinite(currentTs) || currentTs < 0 || currentTs > generatedAt) return false;
    const windows = row.windows as Partial<Record<RotationWindow, unknown>>;
    if (!ROTATION_WINDOWS.every((window) => validMetric(windows[window], window, currentTs))) return false;
    identities.add(identityKey(row.contract));
    return true;
  });
}

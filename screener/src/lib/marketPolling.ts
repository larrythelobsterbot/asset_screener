import type { AssetData } from "@/lib/types";
import type { HlDerivsResponse } from "@/lib/hlDerivs";
import { SECTORS } from "@/config/sectors";

const NULLABLE_NUMBER_FIELDS = [
  "change1h",
  "change4h",
  "change24h",
  "change7d",
  "fundingRate",
  "openInterest",
  "markPrice",
  "oraclePrice",
  "oiUsd",
  "oiChange24hUsd",
  "oiChange24hPct",
  "oiChange7dUsd",
  "oiChange7dPct",
  "fundingAvg24h",
  "volOiRatio",
] as const satisfies readonly (keyof AssetData)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isAssetData(value: unknown): value is AssetData {
  if (!isRecord(value)) return false;
  if (typeof value.symbol !== "string" || value.symbol.trim() === "") return false;
  if (typeof value.name !== "string" || value.name.trim() === "") return false;
  if (typeof value.sector !== "string" || !(value.sector in SECTORS)) return false;
  if (typeof value.sectorColor !== "string") return false;
  if (typeof value.price !== "number" || !Number.isFinite(value.price)) return false;
  if (
    typeof value.volume24h !== "number"
    || !Number.isFinite(value.volume24h)
    || value.volume24h < 0
  ) return false;
  if (value.source !== "hyperliquid" && value.source !== "coingecko") return false;
  if (value.contract != null) {
    if (!isRecord(value.contract)
      || (value.contract.kind !== "native" && value.contract.kind !== "hip3")
      || (value.contract.dex !== null && typeof value.contract.dex !== "string")
      || typeof value.contract.wireCoin !== "string"
      || typeof value.contract.historyKey !== "string") return false;
  }
  if (!NULLABLE_NUMBER_FIELDS.every((field) => isFiniteOrNull(value[field]))) return false;
  for (const field of ["oiCoins", "oiCoinsChange24hPct", "oiQuantityDelta24hUsd", "oiCoinsChange7dPct", "oiQuantityDelta7dUsd"]) {
    if (value[field] !== undefined && !isFiniteOrNull(value[field])) return false;
  }
  for (const field of ["positioning24h", "positioning7d"]) {
    const metadata = value[field];
    if (metadata !== undefined && (!isRecord(metadata)
      || !["observed", "unavailable", "stale"].includes(String(metadata.status))
      || (metadata.currentTs !== null && !isFiniteNumber(metadata.currentTs))
      || (metadata.priorTs !== null && !isFiniteNumber(metadata.priorTs))
      || (metadata.historicalAgeMs !== null && !isFiniteNumber(metadata.historicalAgeMs))
      || metadata.source !== "price_snapshots")) return false;
  }
  return true;
}

/** Reject a malformed successful response before it can poison React state. */
export function parseMarketPayload(value: unknown): AssetData[] {
  if (!Array.isArray(value)) {
    throw new Error("Invalid market response: expected an array");
  }
  if (!value.every(isAssetData)) {
    throw new Error("Invalid market response: malformed asset row");
  }
  return value;
}

export interface LatestRequestGate {
  start(): number;
  isCurrent(requestId: number): boolean;
  close(): void;
}

/**
 * Monotonic request tokens prevent a slower earlier poll from committing after
 * a newer poll, and suppress every commit after the owning effect unmounts.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let latestRequestId = 0;
  let closed = false;

  return {
    start() {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent(requestId) {
      return !closed && requestId === latestRequestId;
    },
    close() {
      closed = true;
    },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

function isDerivsItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.base !== "string" || !isRecord(value.contract)) return false;
  if (
    (value.contract.kind !== "native" && value.contract.kind !== "hip3")
    || (value.contract.dex !== null && typeof value.contract.dex !== "string")
    || typeof value.contract.wireCoin !== "string"
    || typeof value.contract.historyKey !== "string"
    || typeof value.quadrant !== "string"
    || !["observed", "unavailable", "stale"].includes(String(value.observationStatus))
  ) return false;
  for (const field of ["price", "oiUsd", "oiCoins", "volume24h"]) {
    if (!isFiniteNumber(value[field])) return false;
  }
  if (value.observationAt !== null && !isFiniteNumber(value.observationAt)) return false;
  for (const field of ["priceDeltaPct", "oiDeltaPct", "oiCoinsChangePct", "oiQuantityDeltaUsd", "observationAgeMs", "priorObservationAt"]) {
    if (!isNullableFiniteNumber(value[field])) return false;
  }
  return isRecord(value.spark)
    && Array.isArray(value.spark.px)
    && Array.isArray(value.spark.oi)
    && Array.isArray(value.spark.oiCoins)
    && value.spark.px.every(isFiniteNumber)
    && value.spark.oi.every(isFiniteNumber)
    && value.spark.oiCoins.every(isFiniteNumber)
    && isNullableFiniteNumber(value.fundingHourly)
    && typeof value.regime === "string"
    && value.observationSource === "price_snapshots";
}

/** Reject successful-but-malformed radar bodies before they reach React. */
export function parseDerivsPayload(value: unknown): HlDerivsResponse | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !value.items.every(isDerivsItem) || !isRecord(value.metadata)) return null;
  const metadata = value.metadata;
  if (
    !isFiniteNumber(metadata.generatedAt)
    || (metadata.sourceObservedAt !== null && !isFiniteNumber(metadata.sourceObservedAt))
    || !isFiniteNumber(metadata.ageMs)
    || (metadata.sourceAgeMs !== undefined && metadata.sourceAgeMs !== null && !isFiniteNumber(metadata.sourceAgeMs))
    || (metadata.status !== "fresh" && metadata.status !== "stale")
    || typeof metadata.stale !== "boolean"
    || (metadata.partial !== undefined && typeof metadata.partial !== "boolean")
    || (metadata.failedSources !== undefined && (!Array.isArray(metadata.failedSources) || !metadata.failedSources.every((source) => typeof source === "string")))
    || (metadata.staleSources !== undefined && (!Array.isArray(metadata.staleSources) || !metadata.staleSources.every((source) => typeof source === "string")))
  ) return null;
  return value as unknown as HlDerivsResponse;
}

import type { AssetData } from "@/lib/types";
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
  return NULLABLE_NUMBER_FIELDS.every((field) => isFiniteOrNull(value[field]));
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

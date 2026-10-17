import { NextResponse } from "next/server";

import {
  listOiSurgeEvents,
  listOiSurgeOutcomesForEvents,
  summarizeOiSurgeEvents,
  type OiSurgeEventRow,
} from "@/lib/db";
import {
  OI_SURGE_HORIZONS,
  OI_SURGE_POLICY_VERSION,
  type OiSurgeHorizon,
  type OiSurgeLane,
  type OiSurgePublicEvent,
  type OiSurgePublicPayload,
} from "@/lib/oiSurge";
import { getOiSurgeAlertMode } from "@/lib/oiSurgeDelivery";
import { getOiSurgeSchedulerHealth } from "@/lib/oiSurgeService";

export const dynamic = "force-dynamic";

type PublicPayloadWithDetector = OiSurgePublicPayload & {
  generatedAt: number;
  detector: {
    status: "ok" | "warming" | "stale" | "error";
    lastSuccessfulAt: number | null;
    ageMs: number | null;
    anchorAt: number | null;
    error: string | null;
  };
};

function boundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

function parseOrderedArray<T extends string>(raw: string, allowed: readonly T[]): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const values = new Set(parsed.filter((value): value is T =>
      typeof value === "string" && allowed.includes(value as T)));
    return allowed.filter((value) => values.has(value));
  } catch {
    return [];
  }
}

function publicEvent(
  row: OiSurgeEventRow,
  outcomes: ReturnType<typeof listOiSurgeOutcomesForEvents>,
): OiSurgePublicEvent {
  return {
    id: row.id,
    policyVersion: row.policy_version,
    source: row.source,
    mode: row.mode,
    symbol: row.symbol,
    sector: row.sector,
    startedAt: row.started_at,
    lastDetectedAt: row.last_detected_at,
    severity: row.severity,
    primaryHorizon: row.primary_horizon,
    entryMark: row.entry_mark,
    entryOiUsd: row.entry_oi_usd,
    latestQuadrant: row.latest_quadrant,
    maxOiCoinsChangePct: row.max_oi_coins_change_pct,
    maxQuantityDeltaUsd: row.max_quantity_delta_usd,
    latestPriceChangePct: row.latest_price_change_pct,
    volume24h: row.volume_24h,
    fundingHourly: row.funding_hourly,
    horizons: parseOrderedArray<OiSurgeHorizon>(row.horizons_json, OI_SURGE_HORIZONS),
    lanes: parseOrderedArray<OiSurgeLane>(row.lanes_json, ["relative", "systemic"]),
    outcomes: outcomes
      .filter((outcome) => outcome.event_id === row.id)
      .map((outcome) => ({
        horizon: outcome.horizon,
        status: outcome.status,
        targetAt: outcome.target_at,
        snapshotAt: outcome.snapshot_at,
        mark: outcome.mark,
        returnPct: outcome.return_pct,
        absReturnPct: outcome.abs_return_pct,
        highReturnPct: outcome.high_return_pct,
        lowReturnPct: outcome.low_return_pct,
      })),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = boundedInteger(url.searchParams.get("limit"), 100, 1, 200);
  const windowHours = boundedInteger(url.searchParams.get("hours"), 24, 1, 168);
  const symbolParam = url.searchParams.get("symbol")?.trim().toUpperCase() ?? "";
  const symbol = symbolParam.length > 0 && symbolParam.length <= 32 ? symbolParam : undefined;
  const since = Date.now() - windowHours * 60 * 60_000;
  const rows = listOiSurgeEvents({ since, symbol, limit });
  const outcomes = listOiSurgeOutcomesForEvents(rows.map((row) => row.id));
  const now = Date.now();
  const scheduler = getOiSurgeSchedulerHealth();
  const lastSuccessfulAt = scheduler.lastSuccessfulAt;
  const ageMs = lastSuccessfulAt == null ? null : Math.max(0, now - lastSuccessfulAt);
  const reportStatus = scheduler.lastReport?.scan.status;
  const detectorStatus = scheduler.lastError != null
    ? "error"
    : lastSuccessfulAt == null
      ? "warming"
      : reportStatus === "stale" || (ageMs != null && ageMs > 10 * 60_000)
        ? "stale"
        : "ok";
  const payload: PublicPayloadWithDetector = {
    policyVersion: OI_SURGE_POLICY_VERSION,
    mode: "shadow",
    alertMode: getOiSurgeAlertMode(),
    windowHours,
    generatedAt: now,
    detector: {
      status: detectorStatus,
      lastSuccessfulAt,
      ageMs,
      anchorAt: scheduler.lastReport?.scan.anchorAt ?? null,
      error: scheduler.lastError,
    },
    summary: summarizeOiSurgeEvents(since, symbol),
    events: rows.map((row) => publicEvent(row, outcomes)),
  };
  return NextResponse.json(payload, {
    headers: { "Cache-Control": "private, no-store, no-cache, must-revalidate" },
  });
}

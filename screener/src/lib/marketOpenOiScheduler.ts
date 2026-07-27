import { isTelegramConfigured } from "./telegram";
import { DEFAULT_MARKET_OPEN_OI_SELECTION } from "./marketOpenOi";
import {
  dueMarketOpenSessions,
  type MarketOpenSchedule,
} from "./marketOpenOiCalendar";
import {
  buildMarketOpenOiPreview,
  defaultMarketOpenOiBuildDeps,
  deliverMarketOpenOiPreview,
  persistShadowMarketOpenOiPreview,
  resumeMarketOpenOiDeliveries,
  type MarketOpenOiPreview,
} from "./marketOpenOiService";
import {
  evaluateMarketOpenOiOutcomes,
  type MarketOpenOiOutcomeEvaluation,
} from "./marketOpenOiOutcomeTracker";

export interface MarketOpenOiSchedulerDeps {
  enabled: () => boolean;
  shadowEnabled: () => boolean;
  telegramConfigured: () => boolean;
  dueSessions: (now: number) => MarketOpenSchedule[];
  build: (schedule: MarketOpenSchedule, now: number) => MarketOpenOiPreview;
  deliver: (
    preview: Extract<MarketOpenOiPreview, { status: "ready" }>,
  ) => Promise<"delivered" | "duplicate" | "failed" | "unknown" | "ledger_error">;
  persistShadow: (
    preview: Extract<MarketOpenOiPreview, { status: "ready" }>,
  ) => "shadowed" | "duplicate";
  recover: typeof resumeMarketOpenOiDeliveries;
  evaluate: () => MarketOpenOiOutcomeEvaluation;
  now: () => number;
  minIntervalMs: number;
}

export function isMarketOpenOiEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MARKET_OPEN_OI_ENABLED === "true";
}

export function isMarketOpenOiShadowEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MARKET_OPEN_OI_SHADOW_ENABLED === "true";
}

const defaultDeps: MarketOpenOiSchedulerDeps = {
  enabled: isMarketOpenOiEnabled,
  shadowEnabled: isMarketOpenOiShadowEnabled,
  telegramConfigured: isTelegramConfigured,
  dueSessions: dueMarketOpenSessions,
  build: (schedule, now) => buildMarketOpenOiPreview(
    schedule,
    now,
    DEFAULT_MARKET_OPEN_OI_SELECTION,
    defaultMarketOpenOiBuildDeps,
  ),
  deliver: deliverMarketOpenOiPreview,
  persistShadow: persistShadowMarketOpenOiPreview,
  recover: resumeMarketOpenOiDeliveries,
  evaluate: evaluateMarketOpenOiOutcomes,
  now: Date.now,
  minIntervalMs: 45_000,
};

export type MarketOpenOiSchedulerMode = "disabled" | "shadow" | "delivery";

export interface MarketOpenOiTickResult {
  status: "ok" | "shadow" | "disabled" | "blocked" | "degraded";
  at: number;
  due: number;
  ready: number;
  suppressed: number;
  shadowed: number;
  delivered: number;
  duplicates: number;
  failed: number;
  unknown: number;
  expired: number;
  errors: string[];
  outcomes: MarketOpenOiOutcomeEvaluation;
}

export interface MarketOpenOiSchedulerHealth {
  enabled: boolean;
  mode: MarketOpenOiSchedulerMode;
  lastStartedAt: number | null;
  lastSuccessfulAt: number | null;
  lastError: string | null;
  lastResult: MarketOpenOiTickResult | null;
}

function configuredMode(): MarketOpenOiSchedulerMode {
  if (isMarketOpenOiEnabled()) return "delivery";
  if (isMarketOpenOiShadowEnabled()) return "shadow";
  return "disabled";
}

const health: MarketOpenOiSchedulerHealth = {
  enabled: configuredMode() !== "disabled",
  mode: configuredMode(),
  lastStartedAt: null,
  lastSuccessfulAt: null,
  lastError: null,
  lastResult: null,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

export function getMarketOpenOiSchedulerHealth(): MarketOpenOiSchedulerHealth {
  const mode = configuredMode();
  return { ...health, enabled: mode !== "disabled", mode };
}

function finishTick(result: MarketOpenOiTickResult): MarketOpenOiTickResult {
  if (result.errors.length === 0) {
    health.lastSuccessfulAt = result.at;
    health.lastError = null;
  } else {
    health.lastError = result.errors.join("; ").slice(0, 500);
  }
  health.lastResult = result;
  return result;
}

export async function runMarketOpenOiTick(
  deps: MarketOpenOiSchedulerDeps = defaultDeps,
): Promise<MarketOpenOiTickResult> {
  const at = deps.now();
  health.lastStartedAt = at;
  let outcomes: MarketOpenOiOutcomeEvaluation;
  let outcomeError: string | null = null;
  try {
    outcomes = deps.evaluate();
  } catch (error) {
    outcomeError = `outcome evaluation: ${errorMessage(error)}`;
    outcomes = { scanned: 0, inserted: 0, missing: 0, untrackable: 0, errors: 1 };
  }
  const base: MarketOpenOiTickResult = {
    status: "ok",
    at,
    due: 0,
    ready: 0,
    suppressed: 0,
    shadowed: 0,
    delivered: 0,
    duplicates: 0,
    failed: 0,
    unknown: 0,
    expired: 0,
    errors: outcomeError ? [outcomeError] : [],
    outcomes,
  };

  const deliveryEnabled = deps.enabled();
  const shadowEnabled = deps.shadowEnabled();
  if (!deliveryEnabled && !shadowEnabled) {
    return finishTick({ ...base, status: "disabled" });
  }
  if (deliveryEnabled && !deps.telegramConfigured()) {
    base.errors.push("Telegram is not configured");
    return finishTick({ ...base, status: "blocked" });
  }

  if (deliveryEnabled) {
    try {
      const recovery = await deps.recover();
      base.delivered += recovery.delivered;
      base.failed += recovery.failed;
      base.unknown += recovery.unknown + recovery.reconciledUnknown;
      base.expired += recovery.expired;
    } catch (error) {
      base.errors.push(`delivery recovery: ${errorMessage(error)}`);
    }
  }

  const due = deps.dueSessions(at);
  base.due = due.length;
  for (const schedule of due) {
    try {
      const preview = deps.build(schedule, at);
      if (preview.status === "suppressed") {
        base.suppressed += 1;
        continue;
      }
      base.ready += 1;
      if (!deliveryEnabled) {
        const persisted = deps.persistShadow(preview);
        if (persisted === "shadowed") base.shadowed += 1;
        else base.duplicates += 1;
        continue;
      }
      const delivery = await deps.deliver(preview);
      if (delivery === "delivered") base.delivered += 1;
      else if (delivery === "duplicate") base.duplicates += 1;
      else if (delivery === "failed") base.failed += 1;
      else base.unknown += 1;
    } catch (error) {
      base.errors.push(`${schedule.key}: ${errorMessage(error)}`);
    }
  }

  if (deliveryEnabled && (base.failed > 0 || base.unknown > 0)) {
    base.errors.push(
      `delivery failed=${base.failed} unknown=${base.unknown}; unknown acknowledgements require manual reconciliation`,
    );
  }
  base.status = base.errors.length > 0 ? "degraded" : deliveryEnabled ? "ok" : "shadow";
  return finishTick(base);
}

let tickInFlight: Promise<MarketOpenOiTickResult> | null = null;
let lastTickStartedAt: number | null = null;

export function startMarketOpenOiTick(
  deps: MarketOpenOiSchedulerDeps = defaultDeps,
): Promise<MarketOpenOiTickResult> | null {
  if (tickInFlight) return null;
  const now = deps.now();
  if (
    deps.minIntervalMs > 0
    && lastTickStartedAt !== null
    && now - lastTickStartedAt < deps.minIntervalMs
  ) return null;
  lastTickStartedAt = now;
  tickInFlight = runMarketOpenOiTick(deps).finally(() => {
    tickInFlight = null;
  });
  return tickInFlight;
}

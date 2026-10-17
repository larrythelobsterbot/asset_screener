import {
  listPendingOiSurgeDeliveries,
  markOiSurgeDeliveryAttempted,
  markOiSurgeDeliveryDelivered,
  markOiSurgeDeliveryExpired,
  markOiSurgeDeliveryFailed,
  markOiSurgeDeliveryUnknown,
  reconcileStaleAttemptedOiSurgeDeliveries,
  reserveOiSurgeDelivery,
  type OiSurgeDeliveryRow,
  type OiSurgeEventRow,
} from "./db";
import type { OiSurgeAlertMode, OiSurgeHorizon } from "./oiSurge";
import {
  escapeHtml,
  sendTelegramMessage,
  type SendResult,
} from "./telegram";

export function getOiSurgeAlertMode(
  env: Record<string, string | undefined> = process.env,
): OiSurgeAlertMode {
  return env.OI_SURGE_ALERT_MODE === "extreme-pilot" ? "extreme-pilot" : "shadow";
}

function storedHorizons(row: OiSurgeEventRow): OiSurgeHorizon[] {
  const allowed: readonly OiSurgeHorizon[] = ["5m", "15m", "1h", "4h"];
  try {
    const parsed = JSON.parse(row.horizons_json) as unknown;
    if (!Array.isArray(parsed)) return [row.primary_horizon];
    const values = new Set(parsed.filter(
      (value): value is OiSurgeHorizon =>
        typeof value === "string" && allowed.includes(value as OiSurgeHorizon),
    ));
    const horizons = allowed.filter((value) => values.has(value));
    return horizons.length > 0 ? horizons : [row.primary_horizon];
  } catch {
    return [row.primary_horizon];
  }
}

function signedPct(value: number, decimals = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

function signedUsd(value: number): string {
  const sign = value >= 0 ? "+" : "-";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`;
  return `${sign}$${(absolute / 1_000).toFixed(0)}K`;
}

function quadrantLabel(row: OiSurgeEventRow): string {
  if (row.latest_quadrant === "expanding_up") return "OI↑ + price↑";
  if (row.latest_quadrant === "expanding_down") return "OI↑ + price↓";
  return "OI↑ + price flat";
}

export function formatOiSurgeTelegram(row: OiSurgeEventRow): string {
  const horizons = storedHorizons(row).join(" · ");
  const funding = row.funding_hourly == null
    ? "—"
    : signedPct(row.funding_hourly * 100, 4);
  return [
    `<b>EXTREME OI SURGE</b> · <b>${escapeHtml(row.symbol)}</b>`,
    `${escapeHtml(row.source === "hyperliquid" ? "Hyperliquid" : row.source)} · ${escapeHtml(row.sector)} · ${horizons}`,
    `OI <b>${signedPct(row.max_oi_coins_change_pct)}</b> · qty effect <b>${signedUsd(row.max_quantity_delta_usd)}</b>`,
    `Price ${signedPct(row.latest_price_change_pct)} · ${quadrantLabel(row)}`,
    `OI ${signedUsd(row.entry_oi_usd).replace(/^\+/, "")} · vol24h ${signedUsd(row.volume_24h).replace(/^\+/, "")} · funding ${funding}/h`,
    "<i>Informational attention/risk signal — not a trade signal.</i>",
  ].join("\n");
}

export interface OiSurgeDeliveryDeps {
  mode: () => OiSurgeAlertMode;
  reserve: typeof reserveOiSurgeDelivery;
  markAttempted: typeof markOiSurgeDeliveryAttempted;
  send: (body: string) => Promise<SendResult>;
  markDelivered: typeof markOiSurgeDeliveryDelivered;
  markFailed: typeof markOiSurgeDeliveryFailed;
  markUnknown: typeof markOiSurgeDeliveryUnknown;
  now: () => number;
}

export interface OiSurgeRecoveryDeps extends OiSurgeDeliveryDeps {
  listPending: typeof listPendingOiSurgeDeliveries;
  reconcile: typeof reconcileStaleAttemptedOiSurgeDeliveries;
  markExpired: typeof markOiSurgeDeliveryExpired;
}

export type OiSurgeDeliveryResult =
  | "shadow"
  | "ineligible"
  | "duplicate"
  | "delivered"
  | "failed"
  | "unknown"
  | "ledger_error";

const defaultDeliveryDeps: OiSurgeDeliveryDeps = {
  mode: getOiSurgeAlertMode,
  reserve: reserveOiSurgeDelivery,
  markAttempted: markOiSurgeDeliveryAttempted,
  send: (body) => sendTelegramMessage(body, { disableLinkPreview: true }),
  markDelivered: markOiSurgeDeliveryDelivered,
  markFailed: markOiSurgeDeliveryFailed,
  markUnknown: markOiSurgeDeliveryUnknown,
  now: Date.now,
};

const defaultRecoveryDeps: OiSurgeRecoveryDeps = {
  ...defaultDeliveryDeps,
  listPending: listPendingOiSurgeDeliveries,
  reconcile: reconcileStaleAttemptedOiSurgeDeliveries,
  markExpired: markOiSurgeDeliveryExpired,
};

const OI_SURGE_SEND_WINDOW_MS = 15 * 60_000;

function sanitizeDeliveryError(error: unknown): string {
  return String(error ?? "unknown Telegram delivery error")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]")
    .replace(/(TELEGRAM_BOT_TOKEN\s*=\s*)[^\s&]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

async function attemptReservedDelivery(
  eventId: number,
  body: string,
  deps: OiSurgeDeliveryDeps,
): Promise<Exclude<OiSurgeDeliveryResult, "shadow" | "ineligible" | "duplicate">> {
  if (!deps.markAttempted(eventId, deps.now())) return "ledger_error";

  let result: SendResult;
  try {
    result = await deps.send(body);
  } catch (error) {
    deps.markUnknown(eventId, sanitizeDeliveryError(error), deps.now());
    return "unknown";
  }
  if (!result.ok || result.messageId == null) {
    const error = result.ok
      ? "Telegram acknowledged delivery without a message id"
      : result.error ?? "Telegram delivery failed without an error description";
    if (result.ok || result.failureKind === "unknown") {
      deps.markUnknown(eventId, sanitizeDeliveryError(error), deps.now());
      return "unknown";
    }
    deps.markFailed(eventId, sanitizeDeliveryError(error), deps.now());
    return "failed";
  }
  if (!deps.markDelivered(eventId, String(result.messageId), deps.now())) {
    deps.markUnknown(eventId, "Telegram acknowledgement could not be persisted", deps.now());
    return "unknown";
  }
  return "delivered";
}

export async function deliverExtremeOiSurgeEvent(
  event: OiSurgeEventRow,
  deps: OiSurgeDeliveryDeps = defaultDeliveryDeps,
): Promise<OiSurgeDeliveryResult> {
  if (deps.mode() !== "extreme-pilot") return "shadow";
  if (event.severity !== "extreme") return "ineligible";
  const body = formatOiSurgeTelegram(event);
  const reservation = deps.reserve(event.id, body, "extreme-pilot", deps.now());
  if (reservation.kind !== "inserted") return reservation.kind;
  return attemptReservedDelivery(event.id, body, deps);
}

export interface OiSurgeRecoverySummary {
  mode: OiSurgeAlertMode;
  reconciledUnknown: number;
  resumed: number;
  expired: number;
  delivered: number;
  failed: number;
  unknown: number;
}

export async function resumeOiSurgeDeliveries(
  deps: OiSurgeRecoveryDeps = defaultRecoveryDeps,
): Promise<OiSurgeRecoverySummary> {
  const mode = deps.mode();
  const summary: OiSurgeRecoverySummary = {
    mode,
    reconciledUnknown: 0,
    resumed: 0,
    expired: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
  };
  const now = deps.now();
  summary.reconciledUnknown = deps.reconcile(now - OI_SURGE_SEND_WINDOW_MS, now);
  const pending: OiSurgeDeliveryRow[] = deps.listPending(20);
  for (const row of pending) {
    if (now >= row.created_at + OI_SURGE_SEND_WINDOW_MS) {
      if (deps.markExpired(row.event_id, "OI surge send window elapsed", now)) summary.expired += 1;
      else summary.unknown += 1;
      continue;
    }
    if (mode !== "extreme-pilot") continue;
    summary.resumed += 1;
    const result = await attemptReservedDelivery(row.event_id, row.message_body, deps);
    if (result === "delivered") summary.delivered += 1;
    else if (result === "failed") summary.failed += 1;
    else summary.unknown += 1;
  }
  return summary;
}

import type { Sector } from "@/config/sectors";
import type { AssetData } from "./types";
import { cache } from "./cache";
import type {
  NewMarketOpenOiItem,
  NewMarketOpenOiReport,
  SmartFlowPoint,
} from "./db";
import {
  markMarketOpenOiDelivered,
  markMarketOpenOiDeliveryAttempted,
  markMarketOpenOiExpired,
  markMarketOpenOiFailed,
  markMarketOpenOiUnknown,
  listPendingMarketOpenOiReports,
  reconcileStaleAttemptedMarketOpenOiReports,
  reserveMarketOpenOiReport,
  smartFlowAt,
  snapshotFullAtBounded,
  trackedWallets,
} from "./db";
import { displayScaleOf } from "./hyperliquid";
import { sendTelegramMessage, type SendResult } from "./telegram";
import {
  DEFAULT_MARKET_OPEN_OI_SELECTION,
  deriveMarketOpenOiItem,
  formatMarketOpenOiTelegram,
  marketOpenUniverse,
  selectMarketOpenOiItems,
  type MarketOpenOiSelection,
  type MarketOpenOiSelectionConfig,
  type MarketOpenOiSnapshot,
} from "./marketOpenOi";
import {
  MARKET_OPEN_OI_DUE_GRACE_MS,
  type MarketOpenSchedule,
} from "./marketOpenOiCalendar";

export const MARKET_OPEN_OI_LOOKBACK_MS = 4 * 60 * 60_000;
export const MARKET_OPEN_OI_SNAPSHOT_TOLERANCE_MS = 8 * 60_000;
export const MARKET_OPEN_OI_POLICY_VERSION = "market-open-oi-v1";

export interface MarketOpenOiSourceAsset {
  symbol: string;
  sector: Sector;
  displayScale: number;
}

export interface MarketOpenOiBuildDeps {
  assets: () => MarketOpenOiSourceAsset[];
  snapshots: (
    targetAt: number,
    toleranceMs: number,
    symbols: string[],
  ) => Map<string, MarketOpenOiSnapshot>;
  smartFlowDeltas: (at: number, lookbackMs: number) => Map<string, number>;
}

export function computeMarketOpenOiSmartFlowDeltas(
  current: Map<string, SmartFlowPoint>,
  prior: Map<string, SmartFlowPoint>,
): Map<string, number> {
  if (current.size === 0 || prior.size === 0) return new Map();
  const symbols = new Set([...current.keys(), ...prior.keys()]);
  const deltas = new Map<string, number>();
  for (const symbol of symbols) {
    deltas.set(symbol, (current.get(symbol)?.netUsd ?? 0) - (prior.get(symbol)?.netUsd ?? 0));
  }
  return deltas;
}

export function marketOpenOiAssetsFromMarkets(markets: AssetData[]): MarketOpenOiSourceAsset[] {
  const seen = new Set<string>();
  const assets: MarketOpenOiSourceAsset[] = [];
  for (const market of markets) {
    if (market.source !== "hyperliquid" || seen.has(market.symbol)) continue;
    const sector = market.sector;
    if (!marketOpenUniverse(sector)) continue;
    seen.add(market.symbol);
    assets.push({ symbol: market.symbol, sector, displayScale: displayScaleOf(market.symbol) });
  }
  return assets;
}

export const defaultMarketOpenOiBuildDeps: MarketOpenOiBuildDeps = {
  assets: () => {
    const markets = cache.get<AssetData[]>("api:markets");
    return markets ? marketOpenOiAssetsFromMarkets(markets) : [];
  },
  snapshots: snapshotFullAtBounded,
  smartFlowDeltas: (at, lookbackMs) => {
    const cohort = trackedWallets().map((wallet) => wallet.address);
    if (cohort.length === 0) return new Map();
    const current = smartFlowAt(at, 20 * 60_000, cohort);
    const prior = smartFlowAt(at - lookbackMs, 20 * 60_000, cohort);
    return computeMarketOpenOiSmartFlowDeltas(current, prior);
  },
};

export interface MarketOpenOiSuppressionDiagnostics {
  stage: "source_assets" | "snapshots" | "selection";
  requestedAssets: number;
  currentSnapshots: number;
  priorSnapshots: number;
  pairedSnapshots: number;
  missingCurrent: number;
  missingPrior: number;
  derivedAssets: number;
  selectedAssets: number;
}

export type MarketOpenOiPreview =
  | {
      status: "suppressed";
      reason: "insufficient_assets" | "insufficient_snapshots";
      diagnostics?: MarketOpenOiSuppressionDiagnostics;
    }
  | {
      status: "ready";
      report: NewMarketOpenOiReport;
      items: NewMarketOpenOiItem[];
      selection: MarketOpenOiSelection;
      body: string;
    };

function toDbItems(selection: MarketOpenOiSelection): NewMarketOpenOiItem[] {
  return ([selection.crypto, selection.equity] as const).flatMap((group) =>
    group.map((item, index) => ({
      rank: index + 1,
      symbol: item.symbol,
      sector: item.sector,
      universe: item.universe,
      current_ts: item.currentTs,
      prior_ts: item.priorTs,
      current_mark: item.currentMark,
      prior_mark: item.priorMark,
      current_oi_coins: item.currentOiCoins,
      prior_oi_coins: item.priorOiCoins,
      current_oi_usd: item.currentOiUsd,
      prior_oi_usd: item.priorOiUsd,
      oi_quantity_delta_usd: item.oiQuantityDeltaUsd,
      oi_usd_delta: item.oiUsdDelta,
      oi_coins_change_pct: item.oiCoinsChangePct,
      price_change_pct: item.priceChangePct,
      funding_hourly: item.fundingHourly,
      funding_apr: item.fundingApr,
      volume_24h: item.volume24h,
      quadrant: item.quadrant,
      smart_flow_delta_usd: item.smartFlowDeltaUsd,
      smart_flow_alignment: item.smartFlowAlignment,
    })),
  );
}

export function buildMarketOpenOiPreview(
  schedule: MarketOpenSchedule,
  generatedAt: number,
  selectionConfig: MarketOpenOiSelectionConfig = DEFAULT_MARKET_OPEN_OI_SELECTION,
  deps: MarketOpenOiBuildDeps,
): MarketOpenOiPreview {
  const assets = deps.assets();
  if (assets.length < 2) {
    return {
      status: "suppressed",
      reason: "insufficient_assets",
      diagnostics: {
        stage: "source_assets",
        requestedAssets: assets.length,
        currentSnapshots: 0,
        priorSnapshots: 0,
        pairedSnapshots: 0,
        missingCurrent: assets.length,
        missingPrior: assets.length,
        derivedAssets: 0,
        selectedAssets: 0,
      },
    };
  }
  const symbols = assets.map((asset) => asset.symbol);
  const current = deps.snapshots(generatedAt, MARKET_OPEN_OI_SNAPSHOT_TOLERANCE_MS, symbols);
  const priorAt = generatedAt - MARKET_OPEN_OI_LOOKBACK_MS;
  const prior = deps.snapshots(priorAt, MARKET_OPEN_OI_SNAPSHOT_TOLERANCE_MS, symbols);
  const currentSnapshots = symbols.filter((symbol) => current.has(symbol)).length;
  const priorSnapshots = symbols.filter((symbol) => prior.has(symbol)).length;
  const pairedSnapshots = symbols.filter((symbol) => current.has(symbol) && prior.has(symbol)).length;
  if (current.size < 2 || prior.size < 2) {
    return {
      status: "suppressed",
      reason: "insufficient_snapshots",
      diagnostics: {
        stage: "snapshots",
        requestedAssets: assets.length,
        currentSnapshots,
        priorSnapshots,
        pairedSnapshots,
        missingCurrent: assets.length - currentSnapshots,
        missingPrior: assets.length - priorSnapshots,
        derivedAssets: 0,
        selectedAssets: 0,
      },
    };
  }
  const flow = deps.smartFlowDeltas(generatedAt, MARKET_OPEN_OI_LOOKBACK_MS);
  const derived = assets.flatMap((asset) => {
    const currentPoint = current.get(asset.symbol);
    const priorPoint = prior.get(asset.symbol);
    if (!currentPoint || !priorPoint) return [];
    const item = deriveMarketOpenOiItem({
      symbol: asset.symbol,
      sector: asset.sector,
      displayScale: asset.displayScale,
      current: currentPoint,
      prior: priorPoint,
      smartFlowDeltaUsd: flow.get(asset.symbol) ?? null,
    });
    return item ? [item] : [];
  });
  const selection = selectMarketOpenOiItems(derived, schedule.region, selectionConfig);
  const selectedAssets = selection.crypto.length + selection.equity.length;
  const body = formatMarketOpenOiTelegram({
    region: schedule.region,
    sessionLabel: schedule.label,
    localDate: schedule.localDate,
    reportAt: schedule.reportAt,
    openAt: schedule.openAt,
    generatedAt,
    lookbackMs: MARKET_OPEN_OI_LOOKBACK_MS,
    calendarCovered: schedule.calendarCovered,
    selection,
  });
  if (!body) {
    return {
      status: "suppressed",
      reason: "insufficient_assets",
      diagnostics: {
        stage: "selection",
        requestedAssets: assets.length,
        currentSnapshots,
        priorSnapshots,
        pairedSnapshots,
        missingCurrent: assets.length - currentSnapshots,
        missingPrior: assets.length - priorSnapshots,
        derivedAssets: derived.length,
        selectedAssets,
      },
    };
  }
  const report: NewMarketOpenOiReport = {
    report_key: schedule.key,
    region: schedule.region,
    local_date: schedule.localDate,
    report_at: schedule.reportAt,
    open_at: schedule.openAt,
    generated_at: generatedAt,
    lookback_ms: MARKET_OPEN_OI_LOOKBACK_MS,
    calendar_covered: schedule.calendarCovered ? 1 : 0,
    selection_config_json: JSON.stringify({
      policyVersion: MARKET_OPEN_OI_POLICY_VERSION,
      selection: selectionConfig,
    }),
    message_body: body,
  };
  return { status: "ready", report, items: toDbItems(selection), selection, body };
}

type ReadyMarketOpenOiPreview = Extract<MarketOpenOiPreview, { status: "ready" }>;

export interface MarketOpenOiDeliveryDeps {
  reserve: typeof reserveMarketOpenOiReport;
  markAttempted: typeof markMarketOpenOiDeliveryAttempted;
  send: (body: string) => Promise<SendResult>;
  markDelivered: typeof markMarketOpenOiDelivered;
  markFailed: typeof markMarketOpenOiFailed;
  markUnknown: typeof markMarketOpenOiUnknown;
  now: () => number;
}

export interface MarketOpenOiShadowDeps {
  reserve: typeof reserveMarketOpenOiReport;
}

export interface MarketOpenOiRecoveryDeps extends MarketOpenOiDeliveryDeps {
  listPending: typeof listPendingMarketOpenOiReports;
  reconcile: typeof reconcileStaleAttemptedMarketOpenOiReports;
  markExpired: typeof markMarketOpenOiExpired;
}

const defaultMarketOpenOiDeliveryDeps: MarketOpenOiDeliveryDeps = {
  reserve: reserveMarketOpenOiReport,
  markAttempted: markMarketOpenOiDeliveryAttempted,
  send: (body) => sendTelegramMessage(body, { disableLinkPreview: true }),
  markDelivered: markMarketOpenOiDelivered,
  markFailed: markMarketOpenOiFailed,
  markUnknown: markMarketOpenOiUnknown,
  now: Date.now,
};

const defaultMarketOpenOiRecoveryDeps: MarketOpenOiRecoveryDeps = {
  ...defaultMarketOpenOiDeliveryDeps,
  listPending: listPendingMarketOpenOiReports,
  reconcile: reconcileStaleAttemptedMarketOpenOiReports,
  markExpired: markMarketOpenOiExpired,
};

function sanitizeDeliveryError(error: unknown): string {
  return String(error ?? "unknown Telegram delivery error")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]")
    .replace(/(TELEGRAM_BOT_TOKEN\s*=\s*)[^\s&]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

type MarketOpenOiDeliveryResult = "delivered" | "failed" | "unknown" | "ledger_error";

async function attemptReservedMarketOpenOiDelivery(
  reportId: number,
  body: string,
  deps: MarketOpenOiDeliveryDeps,
): Promise<MarketOpenOiDeliveryResult> {
  const attemptedAt = deps.now();
  if (!deps.markAttempted(reportId, attemptedAt)) return "ledger_error";

  let result: SendResult;
  try {
    result = await deps.send(body);
  } catch (error) {
    deps.markUnknown(reportId, sanitizeDeliveryError(error), deps.now());
    return "unknown";
  }
  if (!result.ok || result.messageId == null) {
    const error = result.ok
      ? "Telegram acknowledged delivery without a message id"
      : result.error ?? "Telegram delivery failed without an error description";
    if (result.ok || result.failureKind === "unknown") {
      deps.markUnknown(reportId, sanitizeDeliveryError(error), deps.now());
      return "unknown";
    }
    deps.markFailed(reportId, sanitizeDeliveryError(error), deps.now());
    return "failed";
  }
  if (!deps.markDelivered(reportId, String(result.messageId), deps.now())) {
    deps.markUnknown(reportId, "Telegram acknowledgement could not be persisted", deps.now());
    return "unknown";
  }
  return "delivered";
}

export async function deliverMarketOpenOiPreview(
  preview: ReadyMarketOpenOiPreview,
  deps: MarketOpenOiDeliveryDeps = defaultMarketOpenOiDeliveryDeps,
): Promise<MarketOpenOiDeliveryResult | "duplicate"> {
  const reservation = deps.reserve(preview.report, preview.items, "pending");
  if (reservation.kind === "duplicate") return "duplicate";
  return attemptReservedMarketOpenOiDelivery(reservation.id, preview.body, deps);
}

export function persistShadowMarketOpenOiPreview(
  preview: ReadyMarketOpenOiPreview,
  deps: MarketOpenOiShadowDeps = { reserve: reserveMarketOpenOiReport },
): "shadowed" | "duplicate" {
  const reservation = deps.reserve(preview.report, preview.items, "shadow");
  return reservation.kind === "inserted" ? "shadowed" : "duplicate";
}

export async function resumeMarketOpenOiDeliveries(
  deps: MarketOpenOiRecoveryDeps = defaultMarketOpenOiRecoveryDeps,
): Promise<{
  reconciledUnknown: number;
  resumed: number;
  expired: number;
  delivered: number;
  failed: number;
  unknown: number;
}> {
  const now = deps.now();
  const reconciledUnknown = deps.reconcile(now - 15 * 60_000, now);
  const pending = deps.listPending(20).filter((row) => row.delivery_attempted_at === null);
  const summary = {
    reconciledUnknown,
    resumed: 0,
    expired: 0,
    delivered: 0,
    failed: 0,
    unknown: 0,
  };
  for (const report of pending) {
    if (now >= report.report_at + MARKET_OPEN_OI_DUE_GRACE_MS) {
      if (deps.markExpired(report.id, "Market-open OI send window elapsed", now)) {
        summary.expired += 1;
      } else {
        summary.unknown += 1;
      }
      continue;
    }
    if (now < report.report_at) continue;
    summary.resumed += 1;
    const result = await attemptReservedMarketOpenOiDelivery(report.id, report.message_body, deps);
    if (result === "delivered") summary.delivered += 1;
    else if (result === "failed") summary.failed += 1;
    else summary.unknown += 1;
  }
  return summary;
}

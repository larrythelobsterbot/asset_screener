import { NextResponse } from "next/server";
import { getWsStats } from "@/lib/hyperliquidWs";
import { getTreeNewsWsStats } from "@/lib/treeNewsWs";
import { getTreeNewsStats } from "@/lib/treeNews";
import {
  latestSnapshotTs,
  latestFeedTs,
  latestSocialSnapshotTs,
  latestWalletPositionTs,
  latestHypePressureSnapshot,
  latestBtcBinarySnapshot,
  summarizeTelegramAlerts,
  summarizeMarketOpenOiReports,
  summarizeOiSurgeDeliveries,
  summarizeOiSurgeEvents,
} from "@/lib/db";
import { getHypePressurePollerStats } from "@/lib/hypePressurePoller";
import { getBtcBinaryPollerStats } from "@/lib/btcBinaryPoller";
import { getWalletPollerStats } from "@/lib/walletPoller";
import { getTelegramStats } from "@/lib/telegram";
import { getAlertOutcomeTrackerHealth } from "@/lib/alertOutcomeTracker";
import { getMarketOpenOiSchedulerHealth } from "@/lib/marketOpenOiScheduler";
import { marketOpenCalendarCoverageAt } from "@/lib/marketOpenOiCalendar";
import { getOiSurgeSchedulerHealth } from "@/lib/oiSurgeService";
import { getOiSurgeAlertMode } from "@/lib/oiSurgeDelivery";

// Data-freshness probe for the terminal status bar. A terminal that can
// silently serve stale data is worse than none — this makes staleness
// visible (and was added after the feed sat dead for 6 days unnoticed).

export const dynamic = "force-dynamic";

export interface HealthResponse {
  status: "ok" | "degraded";
  now: number;
  hlWs: { connected: boolean; symbolCount: number; msSinceLastMessage: number };
  treeWs: { connected: boolean; authed: boolean; isSub: boolean | null };
  treePoller: { consecutiveErrors: number };
  snapshotAgeMs: number | null;
  feedAgeMs: number | null;
  socialAgeMs: number | null;
  hypePressureAgeMs: number | null;
  btcBinaryAgeMs: number | null;
  walletPositionAgeMs: number | null;
  pollers: {
    hypePressure: ReturnType<typeof getHypePressurePollerStats>;
    btcBinary: ReturnType<typeof getBtcBinaryPollerStats>;
    wallet: ReturnType<typeof getWalletPollerStats>;
  };
  alerts: {
    telegramProcess: ReturnType<typeof getTelegramStats>;
    ledger: ReturnType<typeof summarizeTelegramAlerts>;
    evaluator: ReturnType<typeof getAlertOutcomeTrackerHealth>;
  };
  marketOpenOi: {
    scheduler: ReturnType<typeof getMarketOpenOiSchedulerHealth>;
    ledger: ReturnType<typeof summarizeMarketOpenOiReports>;
    calendarCoverage: ReturnType<typeof marketOpenCalendarCoverageAt>;
  };
  oiSurges: {
    alertMode: ReturnType<typeof getOiSurgeAlertMode>;
    scheduler: ReturnType<typeof getOiSurgeSchedulerHealth>;
    deliveries24h: ReturnType<typeof summarizeOiSurgeDeliveries>;
    ledger24h: ReturnType<typeof summarizeOiSurgeEvents>;
  };
}

export async function GET() {
  const now = Date.now();
  const hl = getWsStats();
  const tw = getTreeNewsWsStats();
  const tp = getTreeNewsStats();
  const snapTs = latestSnapshotTs();
  const feedTs = latestFeedTs();
  const socialTs = latestSocialSnapshotTs();
  const hypeTs = latestHypePressureSnapshot()?.ts ?? null;
  const btcTs = latestBtcBinarySnapshot()?.ts ?? null;
  const walletTs = latestWalletPositionTs();
  const evaluator = getAlertOutcomeTrackerHealth(now);
  const marketOpenOiScheduler = getMarketOpenOiSchedulerHealth();
  const marketOpenOiDegraded = marketOpenOiScheduler.enabled
    && (marketOpenOiScheduler.lastError != null
      || (marketOpenOiScheduler.lastStartedAt != null && now - marketOpenOiScheduler.lastStartedAt > 5 * 60_000));
  const oiSurgeScheduler = getOiSurgeSchedulerHealth();
  const oiSurgeAlertMode = getOiSurgeAlertMode();
  const oiSurgeDeliveries24h = summarizeOiSurgeDeliveries(now - 24 * 60 * 60_000);
  const telegramStats = getTelegramStats();
  const oiSurgeSchedulerDegraded = oiSurgeScheduler.lastStartedAt != null
    && (oiSurgeScheduler.lastError != null
      || now - oiSurgeScheduler.lastStartedAt > 5 * 60_000
      || (oiSurgeScheduler.lastReport?.scan.errors ?? 0) > 0
      || (oiSurgeScheduler.lastReport?.outcomes.errors ?? 0) > 0
      || (oiSurgeScheduler.lastReport?.delivery.errors ?? 0) > 0);
  const oiSurgeDeliveryDegraded = oiSurgeAlertMode === "extreme-pilot"
    && (!telegramStats.configured
      || oiSurgeDeliveries24h.failed > 0
      || oiSurgeDeliveries24h.unknown > 0);
  const oiSurgeDegraded = oiSurgeSchedulerDegraded || oiSurgeDeliveryDegraded;
  const body: HealthResponse = {
    status: evaluator.stale || marketOpenOiDegraded || oiSurgeDegraded ? "degraded" : "ok",
    now,
    hlWs: {
      connected: hl.connected,
      symbolCount: hl.symbolCount,
      msSinceLastMessage: hl.msSinceLastMessage === Infinity ? -1 : hl.msSinceLastMessage,
    },
    treeWs: { connected: tw.connected, authed: tw.authed, isSub: tw.isSub },
    treePoller: { consecutiveErrors: tp.consecutiveErrors },
    snapshotAgeMs: snapTs != null ? now - snapTs : null,
    feedAgeMs: feedTs != null ? now - feedTs : null,
    socialAgeMs: socialTs != null ? now - socialTs : null,
    hypePressureAgeMs: hypeTs != null ? now - hypeTs : null,
    btcBinaryAgeMs: btcTs != null ? now - btcTs : null,
    walletPositionAgeMs: walletTs != null ? now - walletTs : null,
    pollers: {
      hypePressure: getHypePressurePollerStats(),
      btcBinary: getBtcBinaryPollerStats(),
      wallet: getWalletPollerStats(),
    },
    alerts: {
      telegramProcess: telegramStats,
      ledger: summarizeTelegramAlerts(),
      evaluator,
    },
    marketOpenOi: {
      scheduler: marketOpenOiScheduler,
      ledger: summarizeMarketOpenOiReports(),
      calendarCoverage: marketOpenCalendarCoverageAt(now),
    },
    oiSurges: {
      alertMode: oiSurgeAlertMode,
      scheduler: oiSurgeScheduler,
      deliveries24h: oiSurgeDeliveries24h,
      ledger24h: summarizeOiSurgeEvents(now - 24 * 60 * 60_000),
    },
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

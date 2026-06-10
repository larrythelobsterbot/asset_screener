import { NextResponse } from "next/server";
import { getWsStats } from "@/lib/hyperliquidWs";
import { getTreeNewsWsStats } from "@/lib/treeNewsWs";
import { getTreeNewsStats } from "@/lib/treeNews";
import { latestSnapshotTs, latestFeedTs } from "@/lib/db";

// Data-freshness probe for the terminal status bar. A terminal that can
// silently serve stale data is worse than none — this makes staleness
// visible (and was added after the feed sat dead for 6 days unnoticed).

export const dynamic = "force-dynamic";

export interface HealthResponse {
  now: number;
  hlWs: { connected: boolean; symbolCount: number; msSinceLastMessage: number };
  treeWs: { connected: boolean; authed: boolean; isSub: boolean | null };
  treePoller: { consecutiveErrors: number };
  snapshotAgeMs: number | null;
  feedAgeMs: number | null;
}

export async function GET() {
  const now = Date.now();
  const hl = getWsStats();
  const tw = getTreeNewsWsStats();
  const tp = getTreeNewsStats();
  const snapTs = latestSnapshotTs();
  const feedTs = latestFeedTs();
  const body: HealthResponse = {
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
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

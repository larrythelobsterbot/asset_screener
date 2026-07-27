import { NextRequest, NextResponse } from "next/server";
import {
  listTelegramAlerts,
  summarizeTelegramAlerts,
  type TelegramAlertRow,
} from "@/lib/db";
import {
  parsePerformanceWindowDays,
  summarizeAlertPerformance,
  type AlertPerformanceInput,
} from "@/lib/alertPerformance";

export const dynamic = "force-dynamic";

function convictionLabel(row: TelegramAlertRow): string | null {
  if (!row.conviction_json) return null;
  try {
    const parsed = JSON.parse(row.conviction_json) as { label?: unknown };
    return typeof parsed.label === "string" ? parsed.label : null;
  } catch {
    return null;
  }
}

function performanceInput(row: TelegramAlertRow): AlertPerformanceInput {
  return {
    delivery_status: row.delivery_status,
    delivery_uncertain: row.delivery_uncertain === 1,
    outcome_status: row.outcome_status,
    pnl_r: row.pnl_r,
    conviction_label: convictionLabel(row),
    families_json: row.family_json,
  };
}

export async function GET(request: NextRequest) {
  const windowDays = parsePerformanceWindowDays(request.nextUrl.searchParams.get("days"));
  const now = Date.now();
  const from = now - windowDays * 86_400_000;
  const rows = listTelegramAlerts({ from, to: now, limit: 5_000 });
  const windowLedger = summarizeTelegramAlerts({ from, to: now });
  const sampleTruncated = windowLedger.total > rows.length;
  const summary = summarizeAlertPerformance(rows.map(performanceInput), { sampleTruncated });

  return NextResponse.json({
    generatedAt: now,
    windowDays,
    sampleTruncated,
    allTime: summarizeTelegramAlerts(),
    windowLedger,
    summary,
    alerts: rows.slice(0, 200).map((row) => ({
      id: row.id,
      created_at: row.created_at,
      delivery_status: row.delivery_status,
      delivery_uncertain: row.delivery_uncertain === 1,
      has_delivery_error: row.delivery_error != null,
      symbol: row.symbol,
      direction: row.direction,
      entry_price: row.entry_price,
      stop_price: row.stop_price,
      target_price: row.target_price,
      conviction_score: row.conviction_score,
      conviction_label: convictionLabel(row),
      outcome_status: row.outcome_status,
      pnl_r: row.pnl_r,
      outcome_note: row.outcome_note,
    })),
  }, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

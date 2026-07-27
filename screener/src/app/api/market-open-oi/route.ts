import { NextResponse } from "next/server";

import {
  listMarketOpenOiItemsForReports,
  listMarketOpenOiOutcomesForItems,
  listMarketOpenOiReports,
  summarizeMarketOpenOiReports,
} from "@/lib/db";
import { isAuthorizedAlertOutcomeRequest } from "@/lib/alertOutcomeAuth";
import { MARKET_OPEN_OI_POLICY_VERSION } from "@/lib/marketOpenOiService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedAlertOutcomeRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit") ?? 10);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(20, Math.floor(requested))) : 10;
  const reportRows = listMarketOpenOiReports({ limit });
  const itemRows = listMarketOpenOiItemsForReports(reportRows.map((report) => report.id));
  const outcomeRows = listMarketOpenOiOutcomesForItems(itemRows.map((item) => item.id));
  const outcomesByItem = new Map<number, typeof outcomeRows>();
  for (const outcome of outcomeRows) {
    const rows = outcomesByItem.get(outcome.item_id) ?? [];
    rows.push(outcome);
    outcomesByItem.set(outcome.item_id, rows);
  }
  const itemsByReport = new Map<number, Array<(typeof itemRows)[number] & { outcomes: typeof outcomeRows }>>();
  for (const item of itemRows) {
    const rows = itemsByReport.get(item.report_id) ?? [];
    rows.push({ ...item, outcomes: outcomesByItem.get(item.id) ?? [] });
    itemsByReport.set(item.report_id, rows);
  }
  const reports = reportRows.map((report) => ({
    id: report.id,
    reportKey: report.report_key,
    region: report.region,
    localDate: report.local_date,
    reportAt: report.report_at,
    openAt: report.open_at,
    generatedAt: report.generated_at,
    lookbackMs: report.lookback_ms,
    calendarCovered: report.calendar_covered === 1,
    body: report.message_body,
    deliveryStatus: report.delivery_status,
    deliveredAt: report.delivered_at,
    items: itemsByReport.get(report.id) ?? [],
  }));

  return NextResponse.json({
    policyVersion: MARKET_OPEN_OI_POLICY_VERSION,
    summary: summarizeMarketOpenOiReports(),
    reports,
  }, {
    headers: { "Cache-Control": "private, no-store, no-cache, must-revalidate" },
  });
}

import { NextResponse } from "next/server";

import {
  listMarketOpenOiItems,
  listMarketOpenOiOutcomes,
  listMarketOpenOiReports,
  summarizeMarketOpenOiReports,
} from "@/lib/db";
import { MARKET_OPEN_OI_POLICY_VERSION } from "@/lib/marketOpenOiService";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 20;
  const reports = listMarketOpenOiReports({ limit }).map((report) => ({
    ...report,
    items: listMarketOpenOiItems(report.id).map((item) => ({
      ...item,
      outcomes: listMarketOpenOiOutcomes(item.id),
    })),
  }));

  return NextResponse.json({
    policyVersion: MARKET_OPEN_OI_POLICY_VERSION,
    summary: summarizeMarketOpenOiReports(),
    reports,
  }, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

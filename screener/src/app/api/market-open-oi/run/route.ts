import { NextResponse } from "next/server";

import { isAuthorizedAlertOutcomeRequest } from "@/lib/alertOutcomeAuth";
import {
  getMarketOpenOiSchedulerHealth,
  startMarketOpenOiTick,
} from "@/lib/marketOpenOiScheduler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedAlertOutcomeRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const run = startMarketOpenOiTick();
  const report = run ? await run : null;
  return NextResponse.json({
    accepted: run != null,
    report,
    scheduler: getMarketOpenOiSchedulerHealth(),
  }, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

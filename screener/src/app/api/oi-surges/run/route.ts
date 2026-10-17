import { NextResponse } from "next/server";

import { isAuthorizedAlertOutcomeRequest } from "@/lib/alertOutcomeAuth";
import {
  getOiSurgeSchedulerHealth,
  startOiSurgeTick,
} from "@/lib/oiSurgeService";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedAlertOutcomeRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const run = startOiSurgeTick();
  const report = run ? await run : null;
  return NextResponse.json({
    accepted: run != null,
    report,
    scheduler: getOiSurgeSchedulerHealth(),
  }, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

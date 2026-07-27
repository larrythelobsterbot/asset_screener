import { NextResponse } from "next/server";

import {
  getAlertOutcomeTrackerHealth,
  runAlertOutcomeEvaluation,
} from "@/lib/alertOutcomeTracker";
import { isAuthorizedAlertOutcomeRequest } from "@/lib/alertOutcomeAuth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isAuthorizedAlertOutcomeRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const run = runAlertOutcomeEvaluation();
  const report = run ? await run : null;
  return NextResponse.json({
    accepted: run != null,
    report,
    evaluator: getAlertOutcomeTrackerHealth(),
  }, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}

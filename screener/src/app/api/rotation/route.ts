import { NextResponse } from "next/server";
import { getRotationSnapshot } from "@/lib/rotationService";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const payload = await getRotationSnapshot();
    return NextResponse.json(payload, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "CDN-Cache-Control": "no-store",
        "X-Data-Generated-At": String(payload.generatedAt),
        "X-Data-Age-Ms": String(payload.metadata.cacheAgeMs),
        "X-Data-Stale": String(payload.metadata.stale),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Rotation data is warming or unavailable", detail: String(error) },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

import { NextResponse } from "next/server";

import { cache } from "@/lib/cache";
import type { Signal } from "@/lib/signals";

export const dynamic = "force-dynamic";

const SIGNAL_CACHE_KEY = "api:signals";

/**
 * Cache-only dashboard feed. The server instrumentation owns refreshes through
 * /api/signals; ordinary visitors must never initiate persistence or Telegram
 * work just by opening the homepage.
 */
export async function GET() {
  const snapshot = cache.getInfo<Signal[]>(SIGNAL_CACHE_KEY);

  return NextResponse.json(snapshot?.data ?? [], {
    headers: {
      "Cache-Control": "no-store",
      "X-Data-Stale": String(snapshot ? !snapshot.fresh : true),
      "X-Data-Generated-At": snapshot ? String(snapshot.createdAt) : "",
    },
  });
}

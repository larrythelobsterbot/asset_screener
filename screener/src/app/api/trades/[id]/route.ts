import { NextRequest, NextResponse } from "next/server";
import { closeTrade, getTrade } from "@/lib/db";
import { getMid } from "@/lib/hyperliquidWs";

// /api/trades/[id] — read or close a single trade.
//
// GET    returns the row, or 404 if not found.
// PATCH  closes the trade. Body: { exit_price?, exit_reason, notes? }
//        If exit_price is omitted we use the live WS mid for the symbol.
//        exit_reason is one of 'stop' | 'target' | 'manual' | 'expired'
//        (validated; anything else is a 400).

export const dynamic = "force-dynamic";

interface PatchBody {
  exit_price?: number;
  exit_reason?: "stop" | "target" | "manual" | "expired";
  notes?: string;
}

const VALID_REASONS = new Set(["stop", "target", "manual", "expired"]);

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const row = getTrade(id);
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(row);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: idParam } = await params;
  const id = parseInt(idParam, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.exit_reason || !VALID_REASONS.has(body.exit_reason)) {
    return NextResponse.json(
      { error: "exit_reason must be one of stop|target|manual|expired" },
      { status: 400 }
    );
  }

  // Need the existing row to fall back to live mid for its symbol if
  // exit_price is omitted.
  const existing = getTrade(id);
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const exitPrice = body.exit_price ?? getMid(existing.symbol);
  if (exitPrice == null || !Number.isFinite(exitPrice) || exitPrice <= 0) {
    return NextResponse.json(
      { error: "exit_price missing and no live mid available" },
      { status: 400 }
    );
  }

  const closed = closeTrade(id, exitPrice, body.exit_reason, body.notes);
  if (!closed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(closed);
}

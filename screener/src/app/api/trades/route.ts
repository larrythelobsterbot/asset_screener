import { NextRequest, NextResponse } from "next/server";
import { insertTrade, listTrades, getCandlesFromCache, type TradeRow } from "@/lib/db";
import { sectorOf } from "@/config/sectors";
import { computeTradeCard } from "@/lib/alerter";
import { getMid } from "@/lib/hyperliquidWs";
import { atrPercent } from "@/lib/indicators";

// /api/trades — log a new trade, or list existing trades.
//
// POST  body shape (minimum):
//   { symbol, direction, entry_price?, stop_price?, target_price?, size?,
//     atr_pct?, conviction_score?, conviction_label?, signals?, families?,
//     vol_regime?, funding_hourly?, mode?, notes? }
//
// If entry/stop/target/size are omitted we compute them server-side using
// the same math as the Telegram trade card (computeTradeCard). The caller
// MUST provide atr_pct in that case — otherwise we 400. This keeps the
// modal payload tiny (just symbol + direction + signal snapshot) while
// guaranteeing the journal math agrees with what the alerter shows.
//
// GET  query: symbol? mode=paper|live? status=open|closed|all? limit?
// Returns newest-first.

export const dynamic = "force-dynamic";

const SYMBOL_RE = /^[A-Z0-9._-]{1,24}$/;
const ACCOUNT_USD = parseFloat(process.env.ALERT_ACCOUNT_USD || "2000");
const RISK_PCT = parseFloat(process.env.ALERT_RISK_PCT || "2");

interface PostBody {
  symbol?: string;
  direction?: "long" | "short";
  mode?: "paper" | "live";
  // Either provide these explicitly OR let the server compute from atr_pct.
  entry_price?: number;
  stop_price?: number;
  target_price?: number;
  size?: number;
  risk_usd?: number;
  // Optional snapshot context — captured at decision time for retros.
  atr_pct?: number;
  conviction_score?: number;
  conviction_label?: string;
  vol_regime?: string;
  funding_hourly?: number;
  signals?: unknown;     // serialized as JSON
  families?: unknown;    // serialized as JSON
  notes?: string;
}

export async function POST(req: NextRequest) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const symbol = (body.symbol ?? "").toUpperCase();
  if (!SYMBOL_RE.test(symbol)) {
    return NextResponse.json({ error: "invalid symbol" }, { status: 400 });
  }
  const direction = body.direction;
  if (direction !== "long" && direction !== "short") {
    return NextResponse.json({ error: "direction must be 'long' or 'short'" }, { status: 400 });
  }
  const mode = body.mode === "live" ? "live" : "paper";

  // Entry: prefer client-supplied (locks in the price the user saw on
  // their screen), fall back to live WS mid. If neither is available
  // we can't size the trade.
  const entry = body.entry_price ?? getMid(symbol) ?? null;
  if (entry == null || !Number.isFinite(entry) || entry <= 0) {
    return NextResponse.json(
      { error: "entry_price missing and no live mid available" },
      { status: 400 }
    );
  }

  // Stop/target/size: either provided in full, or computed from ATR.
  // If atr_pct is missing too, derive it from the cached 4h candles —
  // same series the trade-card uses. This lets the UI send the absolute
  // minimum payload ({symbol, direction}) and still get a sized plan.
  let stop = body.stop_price;
  let target = body.target_price;
  let size = body.size;
  let risk_usd = body.risk_usd;
  let atr_pct: number | undefined = body.atr_pct;
  if (stop == null || target == null || size == null) {
    if (atr_pct == null) {
      // Pull last ~60 4h bars from cache; warm-up is 14 so 60 is plenty.
      const candles = getCandlesFromCache(symbol, "4h", 60);
      if (candles.length >= 30) {
        const series = atrPercent(
          candles.map((c) => c.h),
          candles.map((c) => c.l),
          candles.map((c) => c.c),
          14
        );
        const last = series[series.length - 1];
        if (last != null && Number.isFinite(last) && last > 0) atr_pct = last;
      }
    }
    if (atr_pct == null) {
      return NextResponse.json(
        { error: "atr_pct required and 4h candle cache too thin to derive it" },
        { status: 400 }
      );
    }
    const card = computeTradeCard(entry, atr_pct, direction === "long" ? "bullish" : "bearish");
    if (!card) {
      return NextResponse.json({ error: "failed to compute trade card from ATR" }, { status: 400 });
    }
    stop = stop ?? card.stop;
    target = target ?? card.target;
    size = size ?? card.size;
    risk_usd = risk_usd ?? card.riskUsd;
  }
  if (risk_usd == null) {
    // Final fallback if caller provided stop/size but not risk_usd.
    risk_usd = ACCOUNT_USD * (RISK_PCT / 100);
  }

  // Direction-sanity: stop must be BELOW entry for longs, ABOVE for
  // shorts. Catches obvious caller bugs.
  if (direction === "long" && stop >= entry) {
    return NextResponse.json({ error: "long stop must be below entry" }, { status: 400 });
  }
  if (direction === "short" && stop <= entry) {
    return NextResponse.json({ error: "short stop must be above entry" }, { status: 400 });
  }

  const id = insertTrade({
    ts_opened: Date.now(),
    symbol,
    sector: sectorOf(symbol),
    direction,
    mode,
    entry_price: entry,
    stop_price: stop,
    target_price: target,
    size,
    risk_usd,
    conviction_score: body.conviction_score ?? null,
    conviction_label: body.conviction_label ?? null,
    vol_regime: body.vol_regime ?? null,
    atr_pct: atr_pct ?? null,
    funding_hourly: body.funding_hourly ?? null,
    signals_json: body.signals != null ? JSON.stringify(body.signals) : null,
    families_json: body.families != null ? JSON.stringify(body.families) : null,
    notes: body.notes ?? null,
  });

  return NextResponse.json({ id, symbol, direction, entry_price: entry, stop_price: stop, target_price: target, size, mode });
}

export interface TradeListResponse {
  total: number;
  trades: TradeRow[];
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const symbol = q.get("symbol") ?? undefined;
  const modeParam = q.get("mode");
  const mode = modeParam === "paper" || modeParam === "live" ? modeParam : undefined;
  const statusParam = q.get("status");
  const status =
    statusParam === "open" || statusParam === "closed" || statusParam === "all"
      ? statusParam
      : undefined;
  const limit = parseInt(q.get("limit") ?? "200", 10);

  const trades = listTrades({ symbol, mode, status, limit: Number.isFinite(limit) ? limit : 200 });
  const body: TradeListResponse = { total: trades.length, trades };
  return NextResponse.json(body);
}

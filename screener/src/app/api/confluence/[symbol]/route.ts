import { NextRequest, NextResponse } from "next/server";
import { getCandles, getFundingHistory, getMetaAndCtxs } from "@/lib/hyperliquid";
import {
  detectSignals,
  scoreConviction,
  type Signal,
  type Timeframe,
} from "@/lib/signals";
import { HL_PERP_SECTOR_MAP } from "@/config/sectors";
import { cache } from "@/lib/cache";

// Per-symbol confluence endpoint. Runs detectSignals on 1h/4h/1d bars for the
// requested symbol and returns the composed conviction score along with the
// per-timeframe breakdown so consumers (UI drawer, signal bot) can show a
// full picture without having to filter the aggregate /api/signals payload.
//
// Cached for 60 s per symbol — longer than /api/signals (30 s) because a
// single symbol request is cheap to keep fresh on demand and the extra
// headroom lets many consumers hit it concurrently without thrashing.

const TIMEFRAMES: { tf: Timeframe; interval: "1h" | "4h" | "1d"; bars: number }[] = [
  { tf: "1h", interval: "1h", bars: 200 },
  { tf: "4h", interval: "4h", bars: 350 },
  { tf: "1d", interval: "1d", bars: 300 },
];

export async function GET(
  _req: NextRequest,
  { params }: { params: { symbol: string } }
) {
  const symbol = (params.symbol ?? "").toUpperCase();
  if (!symbol) return NextResponse.json({ error: "missing symbol" }, { status: 400 });
  if (!HL_PERP_SECTOR_MAP[symbol]) {
    return NextResponse.json(
      { error: `symbol "${symbol}" is not in the Hyperliquid sector map` },
      { status: 404 }
    );
  }

  const cacheKey = `api:confluence:${symbol}`;
  const cached = cache.get<unknown>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    // Pull the current funding rate from metaAndCtxs so the 4h pass can use
    // it. Cheap — already cached globally at 30 s.
    const { meta, assetCtxs } = await getMetaAndCtxs();
    const idx = meta.universe.findIndex((u) => u.name === symbol);
    const currentFunding =
      idx >= 0 ? parseFloat(assetCtxs[idx]?.funding || "0") : undefined;

    const [fundingHistRaw, ...candleResults] = await Promise.all([
      getFundingHistory(symbol, 168).catch(() => []),
      ...TIMEFRAMES.map((spec) =>
        getCandles(symbol, spec.interval, spec.bars).catch(() => [])
      ),
    ]);

    const fundingHist = fundingHistRaw
      .map((f) => parseFloat(f.fundingRate))
      .filter((x) => Number.isFinite(x));

    const all: Signal[] = [];
    for (let t = 0; t < TIMEFRAMES.length; t++) {
      const candles = candleResults[t];
      if (candles.length < 30) continue;
      const closes = candles.map((c) => parseFloat(c.c));
      const volumes = candles.map((c) => parseFloat(c.v));
      const highs = candles.map((c) => parseFloat(c.h));
      const lows = candles.map((c) => parseFloat(c.l));
      const isPrimary = TIMEFRAMES[t].tf === "4h";
      const signals = detectSignals(
        symbol,
        closes,
        volumes,
        highs,
        lows,
        isPrimary ? currentFunding : undefined,
        isPrimary ? fundingHist : undefined,
        TIMEFRAMES[t].tf
      );
      all.push(...signals);
    }

    const conviction = scoreConviction(all);
    const body = {
      symbol,
      sector: HL_PERP_SECTOR_MAP[symbol].sector,
      label: HL_PERP_SECTOR_MAP[symbol].label,
      generatedAt: Date.now(),
      conviction,
      signals: all,
    };

    cache.set(cacheKey, body, 60_000);
    return NextResponse.json(body);
  } catch (err) {
    const stale = cache.getStale<unknown>(cacheKey);
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

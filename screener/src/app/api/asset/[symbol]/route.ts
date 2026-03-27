import { NextResponse } from "next/server";
import { getCandles, getFundingHistory, getMetaAndCtxs } from "@/lib/hyperliquid";
import { computeAllIndicators } from "@/lib/indicators";
import { detectSignals } from "@/lib/signals";
import { HL_PERP_SECTOR_MAP } from "@/config/sectors";

export async function GET(
  _req: Request,
  { params }: { params: { symbol: string } }
) {
  const { symbol } = params;

  try {
    const isHLPerp = !!HL_PERP_SECTOR_MAP[symbol];

    if (!isHLPerp) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    const [candles, funding, hlData] = await Promise.all([
      getCandles(symbol, "4h", 350),
      getFundingHistory(symbol).catch(() => []),
      getMetaAndCtxs(),
    ]);

    if (!candles.length) {
      return NextResponse.json({ error: "No candle data" }, { status: 404 });
    }

    const closes = candles.map((c) => parseFloat(c.c));
    const volumes = candles.map((c) => parseFloat(c.v));
    const highs = candles.map((c) => parseFloat(c.h));
    const lows = candles.map((c) => parseFloat(c.l));

    const indicators = computeAllIndicators(closes);

    // Get current funding rate from meta
    const idx = hlData.meta.universe.findIndex((u) => u.name === symbol);
    const ctx = idx >= 0 ? hlData.assetCtxs[idx] : null;
    const currentFunding = ctx ? parseFloat(ctx.funding || "0") : undefined;

    const signals = detectSignals(symbol, closes, volumes, highs, lows, currentFunding);

    return NextResponse.json({
      symbol,
      candles: candles.map((c) => ({
        time: Math.floor(c.t / 1000),
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
      })),
      indicators: {
        rsi: indicators.rsi,
        macd: indicators.macd,
        ema13: indicators.ema13,
        ema25: indicators.ema25,
        ema32: indicators.ema32,
        ma100: indicators.ma100,
        ma300: indicators.ma300,
        ema200: indicators.ema200,
      },
      funding: funding.map((f) => ({
        time: Math.floor(f.time / 1000),
        rate: parseFloat(f.fundingRate),
      })),
      signals,
      stats: ctx
        ? {
            price: parseFloat(ctx.markPx),
            oraclePrice: parseFloat(ctx.oraclePx),
            fundingRate: parseFloat(ctx.funding),
            openInterest: parseFloat(ctx.openInterest),
            volume24h: parseFloat(ctx.dayNtlVlm),
          }
        : null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

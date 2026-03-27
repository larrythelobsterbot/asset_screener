import { NextResponse } from "next/server";
import { getCandles, getFundingHistory, getMetaAndCtxs, getAllMids } from "@/lib/hyperliquid";
import { computeAllIndicators } from "@/lib/indicators";
import { detectSignals } from "@/lib/signals";
import { HL_PERP_SECTOR_MAP, HL_SPOT_STOCKS } from "@/config/sectors";

// Reverse lookup: ticker → @name for spot stocks
const TICKER_TO_SPOT: Record<string, string> = {};
for (const [spotName, info] of Object.entries(HL_SPOT_STOCKS)) {
  TICKER_TO_SPOT[info.ticker] = spotName;
}

export async function GET(
  _req: Request,
  { params }: { params: { symbol: string } }
) {
  const { symbol } = params;

  try {
    const isHLPerp = !!HL_PERP_SECTOR_MAP[symbol];
    const spotName = TICKER_TO_SPOT[symbol]; // e.g. "@287" for META
    const isSpotStock = !!spotName;

    if (!isHLPerp && !isSpotStock) {
      return NextResponse.json({ error: "Asset not found" }, { status: 404 });
    }

    // For perps, use the symbol directly for candles
    // For spot stocks, use the @N name for candles
    const candleCoin = isHLPerp ? symbol : spotName;

    const [candles, funding, hlData, allMids] = await Promise.all([
      getCandles(candleCoin, "4h", 350).catch(() => []),
      isHLPerp ? getFundingHistory(symbol).catch(() => []) : Promise.resolve([]),
      getMetaAndCtxs(),
      getAllMids(),
    ]);

    // For spot stocks with no candle data, return basic info
    if (!candles.length) {
      const midPx = spotName ? allMids[spotName] : null;
      const price = midPx ? parseFloat(midPx) : 0;

      return NextResponse.json({
        symbol,
        candles: [],
        indicators: {
          rsi: [], macd: { macd: [], signal: [], histogram: [] },
          ema13: [], ema25: [], ema32: [],
          ma100: [], ma300: [], ema200: [],
        },
        funding: [],
        signals: [],
        stats: price > 0 ? {
          price,
          oraclePrice: price,
          fundingRate: 0,
          openInterest: 0,
          volume24h: 0,
        } : null,
      });
    }

    const closes = candles.map((c) => parseFloat(c.c));
    const volumes = candles.map((c) => parseFloat(c.v));
    const highs = candles.map((c) => parseFloat(c.h));
    const lows = candles.map((c) => parseFloat(c.l));

    const indicators = computeAllIndicators(closes);

    // Get current stats from perp meta (only for perps)
    const idx = hlData.meta.universe.findIndex((u) => u.name === symbol);
    const ctx = idx >= 0 ? hlData.assetCtxs[idx] : null;
    const currentFunding = ctx ? parseFloat(ctx.funding || "0") : undefined;

    const signals = detectSignals(symbol, closes, volumes, highs, lows, currentFunding);

    // For spot stocks, get price from allMids
    const spotPrice = spotName ? parseFloat(allMids[spotName] || "0") : 0;

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
      funding: funding.map((f: any) => ({
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
        : spotPrice > 0
        ? {
            price: spotPrice,
            oraclePrice: spotPrice,
            fundingRate: 0,
            openInterest: 0,
            volume24h: 0,
          }
        : null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

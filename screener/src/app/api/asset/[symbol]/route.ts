import { NextResponse } from "next/server";
import {
  getAllMids,
  getBuilderDexData,
  getCandles,
  getFundingHistory,
  getMetaAndCtxs,
} from "@/lib/hyperliquid";
import { computeAllIndicators } from "@/lib/indicators";
import { detectSignals } from "@/lib/signals";
import { getMid } from "@/lib/hyperliquidWs";
import { resolveAssetMarketIdentity } from "@/lib/assetMarketIdentity";
import { fetchAssetDetailMarketData, selectAssetPerpContext } from "@/lib/assetDetailMarket";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;
  const market = resolveAssetMarketIdentity(symbol);

  // Reject unknown symbols up-front (400) instead of fanning out to HL.
  if (!market) {
    return NextResponse.json(
      { error: `unknown symbol "${symbol}" — not in HL perp/spot/builder universe` },
      { status: 400 }
    );
  }

  try {
    const isSpotStock = market.kind === "spot";
    const spotName = isSpotStock ? market.wireCoin : null;

    // All upstream reads share one resolved market identity. HIP-3 funding
    // and candles require the DEX-qualified wire coin (e.g. xyz:SKHX), while
    // candles remain cached under the bare ticker used by the rest of the app.
    const marketData = await fetchAssetDetailMarketData(market, {
      getCandles,
      getFundingHistory,
      getMetaAndCtxs,
      getAllMids,
      getBuilderDexData,
    });
    const { candles, funding, allMids } = marketData;

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

    const ctx = selectAssetPerpContext(market, marketData);
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
      // For perps, prefer the WS mid if we have a fresh one — this is
      // the price an LTF user actually transacts at. Falls back to REST
      // markPx when the WS isn't connected. We don't overlay on spot
      // stocks because the `allMids` channel doesn't reliably cover the
      // @N spot identifiers.
      stats: ctx
        ? (() => {
            const liveMid = getMid(symbol);
            const price = liveMid != null && liveMid > 0
              ? liveMid
              : parseFloat(ctx.markPx);
            return {
              price,
              oraclePrice: parseFloat(ctx.oraclePx),
              fundingRate: parseFloat(ctx.funding),
              openInterest: parseFloat(ctx.openInterest),
              volume24h: parseFloat(ctx.dayNtlVlm),
            };
          })()
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

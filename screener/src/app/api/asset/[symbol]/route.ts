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
import { marketContract } from "@/lib/marketContract";
import { fetchAssetDetailMarketData, selectAssetPerpContext, assetMarketExistsInLiveUniverse } from "@/lib/assetDetailMarket";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;
  const url = new URL(req.url);
  const wireCoinValues = url.searchParams.getAll("wireCoin");
  if (wireCoinValues.length > 1) {
    return NextResponse.json({ error: "wireCoin must be specified at most once" }, { status: 400 });
  }
  const selectedWireCoin = wireCoinValues[0];
  const market = resolveAssetMarketIdentity(symbol, selectedWireCoin);

  // Reject malformed/unknown identities before any upstream request. An
  // explicit wireCoin is authoritative: never silently fall back to the
  // first configured DEX when its selected venue is absent.
  if (!market) {
    return NextResponse.json(
      { error: selectedWireCoin === undefined
        ? `unknown symbol "${symbol}" — not in HL perp/spot/builder universe`
        : `invalid market identity for "${symbol}"` },
      { status: 400 }
    );
  }
  const selectedContract = market.kind === "spot" ? null : marketContract(symbol, market.builderDex);
  const marketIdentity = {
    kind: market.kind,
    dex: market.builderDex,
    wireCoin: market.wireCoin,
    historyKey: market.cacheSymbol,
  };

  try {
    // Metadata is loaded and checked before candles/funding. This prevents a
    // selected alternative venue from returning another venue's data when a
    // dynamic listing disappeared or the query was forged.
    const hlData = await getMetaAndCtxs();
    const builderData = market.kind === "builder-perp"
      ? await getBuilderDexData(market.builderDex).catch(() => null)
      : null;
    const liveUniverse = market.kind === "builder-perp" ? builderData : hlData;
    if (market.kind !== "spot" && (!liveUniverse || !assetMarketExistsInLiveUniverse(market, liveUniverse, {
      allowBareBuilderName: selectedWireCoin === undefined,
      builderDex: market.kind === "builder-perp" ? market.builderDex : undefined,
    }))) {
      return NextResponse.json(
        { error: `selected market "${market.wireCoin}" is not in the live universe` },
        { status: 400 }
      );
    }

    const isSpotStock = market.kind === "spot";
    const spotName = isSpotStock ? market.wireCoin : null;

    // All upstream reads share one resolved market identity. HIP-3 funding
    // and candles require the DEX-qualified wire coin (e.g. xyz:SKHX).
    const marketData = await fetchAssetDetailMarketData(market, {
      getCandles,
      getFundingHistory,
      getMetaAndCtxs,
      getAllMids,
      getBuilderDexData,
    }, {
      hlData,
      builderData,
      // Legacy bare routes retain their bare candle cache. An explicit
      // selected contract gets a qualified cache namespace to avoid mixing
      // overlapping venues with historical bare-ticker rows.
      candleCacheSymbol: selectedWireCoin ? market.wireCoin : market.cacheSymbol,
    });
    const { candles, funding, allMids } = marketData;

    // For spot stocks with no candle data, return basic info
    if (!candles.length) {
      const midPx = spotName ? allMids[spotName] : null;
      const price = midPx ? parseFloat(midPx) : 0;

      return NextResponse.json({
        symbol,
        marketIdentity,
        contract: selectedContract,
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
      marketIdentity,
      contract: selectedContract,
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

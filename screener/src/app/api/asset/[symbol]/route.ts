import { NextResponse } from "next/server";
import { getCandles, getFundingHistory, getMetaAndCtxs, getAllMids } from "@/lib/hyperliquid";
import { computeAllIndicators } from "@/lib/indicators";
import { detectSignals } from "@/lib/signals";
import { HL_SPOT_STOCKS, HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP, BUILDER_DEXES } from "@/config/sectors";
import { getMid } from "@/lib/hyperliquidWs";

// Reverse lookup: ticker → @name for spot stocks
const TICKER_TO_SPOT: Record<string, string> = {};
for (const [spotName, info] of Object.entries(HL_SPOT_STOCKS)) {
  TICKER_TO_SPOT[info.ticker] = spotName;
}

// Builder-dex perps store their ticker as the part after the ":" prefix.
// Collect bare tickers so the validation accepts e.g. "TSLA" even if the
// dex prefix is in HL_BUILDER_PERP_MAP under "xyz:TSLA".
const BUILDER_TICKERS = new Set<string>();
for (const key of Object.keys(HL_BUILDER_PERP_MAP)) {
  const t = key.includes(":") ? key.split(":")[1] : key;
  if (t) BUILDER_TICKERS.add(t);
}

// Symbol validation: only allow symbols we actually track (native HL
// perp, builder-dex perp, or HIP-3 spot stock). Rejecting unknown
// symbols here prevents a caller from fanning out to Hyperliquid for
// each unique garbage value — that would silently burn rate-limit
// budget for every request.
function isValidSymbol(s: string): boolean {
  if (!s) return false;
  // Loose shape check: 1–24 chars, alphanumeric + a few separators.
  // Anything outside this range is definitely not an HL symbol.
  if (!/^[A-Za-z0-9._-]{1,24}$/.test(s)) return false;
  return (
    s in HL_PERP_SECTOR_MAP ||
    s in TICKER_TO_SPOT ||
    BUILDER_TICKERS.has(s)
  );
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol } = await params;

  // Reject unknown symbols up-front (400) instead of fanning out to HL.
  if (!isValidSymbol(symbol)) {
    return NextResponse.json(
      { error: `unknown symbol "${symbol}" — not in HL perp/spot/builder universe` },
      { status: 400 }
    );
  }

  try {
    const spotName = TICKER_TO_SPOT[symbol]; // e.g. "@287" for META
    const isSpotStock = !!spotName;

    // Candle coin resolution, in precedence order:
    //   spot stock → its "@N" name; native perp → bare symbol;
    //   builder-only ticker → its dex-prefixed coin ("xyz:SKHX").
    // HL's candleSnapshot returns null for a bare builder ticker, so
    // without the prefix every HIP-3 modal open fired a guaranteed-null
    // HL call and rendered empty. Dex search order mirrors the dedup
    // precedence everywhere else (earliest dex in BUILDER_DEXES wins).
    // cacheSymbol stays the bare ticker so these 4h bars land in
    // candles_cache under the same key the rest of the app reads.
    let candleCoin = isSpotStock ? spotName : symbol;
    // Cache key: bare ticker ONLY for the builder branch. Spot stocks keep
    // caching under their "@N" name — a ticker like META names BOTH a spot
    // stock and a builder perp, and filing two venues' series under one
    // (symbol, interval) key would let them overwrite each other.
    let candleCacheAs = candleCoin;
    if (!isSpotStock && !HL_PERP_SECTOR_MAP[symbol] && BUILDER_TICKERS.has(symbol)) {
      for (const dex of BUILDER_DEXES) {
        if (HL_BUILDER_PERP_MAP[`${dex}:${symbol}`]) {
          candleCoin = `${dex}:${symbol}`;
          candleCacheAs = symbol;
          break;
        }
      }
    }

    const [candles, funding, hlData, allMids] = await Promise.all([
      getCandles(candleCoin, "4h", 350, candleCacheAs).catch(() => []),
      !isSpotStock ? getFundingHistory(symbol).catch(() => []) : Promise.resolve([]),
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

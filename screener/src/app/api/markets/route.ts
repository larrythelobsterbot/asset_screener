import { NextResponse } from "next/server";
import { getMetaAndCtxs, getAllMids } from "@/lib/hyperliquid";
import { getMarkets } from "@/lib/coingecko";
import { HL_PERP_SECTOR_MAP, HL_SPOT_STOCKS, SECTORS } from "@/config/sectors";
import { AssetData } from "@/lib/types";
import { cache } from "@/lib/cache";


export async function GET() {
  try {
    const cached = cache.get<AssetData[]>("api:markets");
    if (cached) return NextResponse.json(cached);

    const [hlData, allMids, cgData] = await Promise.all([
      getMetaAndCtxs(),
      getAllMids(),
      getMarkets(),
    ]);

    const assets: AssetData[] = [];

    // Hyperliquid perps
    const { meta, assetCtxs } = hlData;
    for (let i = 0; i < meta.universe.length; i++) {
      const name = meta.universe[i].name;
      const mapping = HL_PERP_SECTOR_MAP[name];
      if (!mapping) continue;

      const ctx = assetCtxs[i];
      let price = parseFloat(ctx.markPx || "0");
      let prevDayPx = parseFloat(ctx.prevDayPx || "0");
      // SPX perp is fractional (~0.287 = SPX/20000)
      if (name === "SPX") { price *= 20000; prevDayPx *= 20000; }
      const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : null;

      assets.push({
        symbol: name,
        name: mapping.label,
        sector: mapping.sector,
        sectorColor: SECTORS[mapping.sector].color,
        price,
        change1h: null,
        change4h: null,
        change24h,
        change7d: null,
        volume24h: parseFloat(ctx.dayNtlVlm || "0"),
        fundingRate: parseFloat(ctx.funding || "0"),
        openInterest: parseFloat(ctx.openInterest || "0"),
        markPrice: price,
        oraclePrice: parseFloat(ctx.oraclePx || "0"),
        source: "hyperliquid",
      });
    }

    // Hyperliquid HIP-3 spot stocks
    for (const [spotName, info] of Object.entries(HL_SPOT_STOCKS)) {
      const midPx = allMids[spotName];
      if (!midPx) continue;

      const price = parseFloat(midPx);
      assets.push({
        symbol: info.ticker,
        name: info.label,
        sector: info.sector,
        sectorColor: SECTORS[info.sector].color,
        price,
        change1h: null,
        change4h: null,
        change24h: null,
        change7d: null,
        volume24h: 0,
        fundingRate: null,
        openInterest: null,
        markPrice: price,
        oraclePrice: null,
        source: "hyperliquid",
      });
    }

    // CoinGecko assets
    for (const coin of cgData) {
      const sector = (coin.market_cap_rank || 999) <= 10 ? "crypto-major" : "crypto-alt";
      assets.push({
        symbol: coin.symbol.toUpperCase(),
        name: coin.name,
        sector,
        sectorColor: SECTORS[sector].color,
        price: coin.current_price,
        change1h: coin.price_change_percentage_1h_in_currency,
        change4h: null,
        change24h: coin.price_change_percentage_24h_in_currency,
        change7d: coin.price_change_percentage_7d_in_currency,
        volume24h: coin.total_volume,
        fundingRate: null,
        openInterest: null,
        markPrice: null,
        oraclePrice: null,
        source: "coingecko",
      });
    }

    cache.set("api:markets", assets, 30_000);
    return NextResponse.json(assets);
  } catch (err) {
    const stale = cache.getStale<AssetData[]>("api:markets");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

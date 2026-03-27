import { NextResponse } from "next/server";
import { getMetaAndCtxs } from "@/lib/hyperliquid";
import { getMarkets } from "@/lib/coingecko";
import { HL_PERP_SECTOR_MAP, SECTORS, Sector } from "@/config/sectors";
import { AssetData } from "@/lib/types";
import { cache } from "@/lib/cache";

export async function GET() {
  try {
    const cached = cache.get<AssetData[]>("api:markets");
    if (cached) return NextResponse.json(cached);

    const [hlData, cgData] = await Promise.all([
      getMetaAndCtxs(),
      getMarkets(),
    ]);

    const assets: AssetData[] = [];

    // ALL Hyperliquid perps — use sector map if available, otherwise auto-classify
    const { meta, assetCtxs } = hlData;
    for (let i = 0; i < meta.universe.length; i++) {
      const name = meta.universe[i].name;
      const ctx = assetCtxs[i];

      let price = parseFloat(ctx.markPx || "0");
      let prevDayPx = parseFloat(ctx.prevDayPx || "0");
      if (name === "SPX") { price *= 20000; prevDayPx *= 20000; }
      const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : null;
      const volume = parseFloat(ctx.dayNtlVlm || "0");

      // Skip zero-price assets
      if (price === 0) continue;

      const mapping = HL_PERP_SECTOR_MAP[name];
      let sector: Sector;
      let label: string;
      let sectorColor: string;

      if (mapping) {
        sector = mapping.sector;
        label = mapping.label;
        sectorColor = SECTORS[sector].color;
      } else {
        // Auto-classify unmapped perps as crypto-alt
        sector = "crypto-alt";
        label = name;
        sectorColor = SECTORS["crypto-alt"].color;
      }

      assets.push({
        symbol: name,
        name: label,
        sector,
        sectorColor,
        price,
        change1h: null,
        change4h: null,
        change24h,
        change7d: null,
        volume24h: volume,
        fundingRate: parseFloat(ctx.funding || "0"),
        openInterest: parseFloat(ctx.openInterest || "0"),
        markPrice: price,
        oraclePrice: parseFloat(ctx.oraclePx || "0"),
        source: "hyperliquid",
      });
    }

    // CoinGecko assets
    for (const coin of cgData) {
      const sector: Sector = (coin.market_cap_rank || 999) <= 10 ? "crypto-major" : "crypto-alt";
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
    return NextResponse.json(assets, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "CDN-Cache-Control": "no-store" },
    });
  } catch (err) {
    const stale = cache.getStale<AssetData[]>("api:markets");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

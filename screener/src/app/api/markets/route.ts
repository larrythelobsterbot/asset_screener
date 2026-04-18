import { NextResponse } from "next/server";
import { getMetaAndCtxs, getBuilderDexData } from "@/lib/hyperliquid";
import { getMarkets } from "@/lib/coingecko";
import { HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP, BUILDER_DEXES, SECTORS, Sector } from "@/config/sectors";
import { AssetData } from "@/lib/types";
import { cache } from "@/lib/cache";

export async function GET() {
  try {
    const cached = cache.get<AssetData[]>("api:markets");
    if (cached) return NextResponse.json(cached);

    const [hlData, cgData, ...builderDexResults] = await Promise.all([
      getMetaAndCtxs(),
      getMarkets(),
      ...BUILDER_DEXES.map((dex) => getBuilderDexData(dex).catch(() => null)),
    ]);

    const assets: AssetData[] = [];

    // ALL Hyperliquid perps — use sector map if available, otherwise auto-classify
    const { meta, assetCtxs } = hlData;
    for (let i = 0; i < meta.universe.length; i++) {
      const name = meta.universe[i].name;
      const ctx = assetCtxs[i];

      let price = parseFloat(ctx.markPx || "0");
      let prevDayPx = parseFloat(ctx.prevDayPx || "0");
      // HL's SPX perp is quoted as (index / 20000) — i.e. 1 unit = 1/20000th
      // of the S&P 500 index level — so we scale back up here to display a
      // number that matches the familiar SPX value (e.g. 5200, not 0.26).
      // This multiplier is specific to HL's SPX contract; if they ever list
      // an un-scaled SPX market (or rename this one) this branch becomes
      // wrong and should be revisited.
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

    // HIP-3 builder-deployed perps — deduplicate against standard HL perps AND each other.
    // Precedence rule: native HL markets win over builder DEXes, and among
    // builder DEXes the first one in BUILDER_DEXES wins. If multiple DEXes
    // list the same ticker we log it so we can see at a glance when a later
    // entry is being silently masked (e.g. if pricing diverges noticeably).
    const seenBuilderSymbols = new Set<string>(assets.map((a) => a.symbol));
    const dedupConflicts: Array<{ ticker: string; loserDex: string; winnerSource: string }> = [];
    for (let di = 0; di < BUILDER_DEXES.length; di++) {
      const dex = BUILDER_DEXES[di];
      const dexData = builderDexResults[di];
      if (!dexData) continue;

      const { meta: dexMeta, assetCtxs: dexCtxs } = dexData;
      for (let i = 0; i < dexMeta.universe.length; i++) {
        const rawName = dexMeta.universe[i].name; // e.g. "xyz:TSLA" or "TSLA"
        // Strip the dex prefix if present in the ticker itself
        const ticker = rawName.includes(":") ? rawName.split(":")[1] : rawName;
        const mapKey = `${dex}:${ticker}`;

        // Deduplicate: first dex (xyz) wins for each ticker symbol.
        // Record the conflict so we can observe drift between venues.
        if (seenBuilderSymbols.has(ticker)) {
          const existing = assets.find((a) => a.symbol === ticker);
          dedupConflicts.push({
            ticker,
            loserDex: dex,
            winnerSource: existing?.source === "hyperliquid" && !existing?.name.startsWith(ticker)
              ? `hyperliquid-native`
              : `builder-earlier`,
          });
          continue;
        }
        seenBuilderSymbols.add(ticker);

        const ctx = dexCtxs[i];
        const price = parseFloat(ctx.markPx || "0");
        const volume = parseFloat(ctx.dayNtlVlm || "0");
        // Skip ghost listings — no price or no trading activity
        if (price === 0 || volume === 0) continue;

        const prevDayPx = parseFloat(ctx.prevDayPx || "0");
        const change24h = prevDayPx > 0 ? ((price - prevDayPx) / prevDayPx) * 100 : null;

        const mapping = HL_BUILDER_PERP_MAP[mapKey];
        const sector: Sector = mapping?.sector ?? "crypto-alt";
        const label: string = mapping?.label ?? ticker;
        const sectorColor = SECTORS[sector].color;

        assets.push({
          symbol: ticker,
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
    }

    // Surface dedup conflicts once per scan (throttled to not spam logs).
    if (dedupConflicts.length > 0) {
      console.info(
        `[markets] builder-dex dedup suppressed ${dedupConflicts.length} duplicate tickers: ` +
          dedupConflicts
            .slice(0, 10)
            .map((c) => `${c.ticker}@${c.loserDex}<-${c.winnerSource}`)
            .join(", ")
      );
    }

    // CoinGecko assets — skip any symbol already covered by a Hyperliquid perp
    const hlSymbols = new Set(assets.map((a) => a.symbol));
    for (const coin of cgData) {
      const sym = coin.symbol.toUpperCase();
      if (hlSymbols.has(sym)) continue; // HL perp data takes precedence
      const sector: Sector = (coin.market_cap_rank || 999) <= 10 ? "crypto-major" : "crypto-alt";
      assets.push({
        symbol: sym,
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

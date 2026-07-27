import { NextResponse } from "next/server";
import { displayScaleOf, getBuilderDexData, getMetaAndCtxs } from "@/lib/hyperliquid";
import { MACRO_INDICATORS } from "@/config/sectors";
import { MacroData } from "@/lib/types";
import { cache } from "@/lib/cache";
import { fetchFredMacroData, FRED_MACRO_SERIES, mergeMacroData } from "@/lib/macro";

// Same static-generation bug as markets/signals — opt out so the handler
// runs per-request and our TTL cache controls freshness.
export const dynamic = "force-dynamic";

const CACHE_KEY = "api:macro";
const CACHE_TTL_MS = 15 * 60_000;
const MAX_STALE_MS = 6 * 60 * 60_000;

function macroResponse(data: MacroData[], stale: boolean) {
  const info = cache.getInfo<MacroData[]>(CACHE_KEY);
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Data-Age-Ms": String(info?.ageMs ?? 0),
      "X-Data-Generated-At": String(info?.createdAt ?? Date.now()),
      "X-Data-Stale": String(stale),
      "X-Data-Degraded": data.some((point) => point.stale) ? "true" : "false",
    },
  });
}

export async function GET() {
  try {
    const cached = cache.get<MacroData[]>(CACHE_KEY);
    if (cached) return macroResponse(cached, cached.some((point) => point.stale));

    const [nativeData, xyzData, fredResults] = await Promise.all([
      getMetaAndCtxs().catch((err) => {
        console.warn("[macro] native Hyperliquid fetch failed:", err);
        return null;
      }),
      getBuilderDexData("xyz").catch((err) => {
        console.warn("[macro] xyz Hyperliquid fetch failed:", err);
        return null;
      }),
      Promise.all(FRED_MACRO_SERIES.map(async (series) => {
        try {
          return await fetchFredMacroData(series);
        } catch (err) {
          console.warn(`[macro] ${series.seriesId} fetch failed:`, err);
          return {
            symbol: series.symbol,
            label: series.label,
            value: null,
            change: null,
            source: "delayed" as const,
            asOf: null,
          };
        }
      })),
    ]);
    const fredBySymbol = new Map(fredResults.map((point) => [point.symbol, point]));

    const macros: MacroData[] = MACRO_INDICATORS.map((m) => {
      if (m.source === "delayed") {
        return fredBySymbol.get(m.symbol) ?? {
          symbol: m.symbol,
          label: m.label,
          value: null,
          change: null,
          source: "delayed" as const,
          asOf: null,
        };
      }
      if (m.source === "live") {
        const dex = "dex" in m ? m.dex : null;
        const marketData = dex === "xyz" ? xyzData : nativeData;
        const marketName = dex ? `${dex}:${m.symbol}` : m.symbol;
        const idx = marketData?.meta.universe.findIndex((u) => u.name === marketName) ?? -1;
        if (idx >= 0) {
          const ctx = marketData!.assetCtxs[idx];
          let price = parseFloat(ctx.markPx || "0");
          let prevDay = parseFloat(ctx.prevDayPx || "0");
          const scale = displayScaleOf(m.symbol);
          price *= scale;
          prevDay *= scale;
          const change = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : null;
          return {
            symbol: m.symbol,
            label: m.label,
            value: price,
            change,
            source: "live" as const,
            asOf: Date.now(),
          };
        }
      }
      return {
        symbol: m.symbol,
        label: m.label,
        value: null,
        change: null,
        source: "static" as const,
        asOf: null,
      };
    });

    const previous = cache.getStaleWithin<MacroData[]>(CACHE_KEY, MAX_STALE_MS) ?? [];
    const merged = mergeMacroData(macros, previous);
    cache.set(CACHE_KEY, merged.data, CACHE_TTL_MS);
    return macroResponse(merged.data, merged.degraded);
  } catch (err) {
    const stale = cache.getStaleWithin<MacroData[]>(CACHE_KEY, MAX_STALE_MS);
    if (stale) return macroResponse(stale.map((point) => ({ ...point, stale: true })), true);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

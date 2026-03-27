import { NextResponse } from "next/server";
import { getMetaAndCtxs } from "@/lib/hyperliquid";
import { MACRO_INDICATORS } from "@/config/sectors";
import { MacroData } from "@/lib/types";
import { cache } from "@/lib/cache";

export async function GET() {
  try {
    const cached = cache.get<MacroData[]>("api:macro");
    if (cached) return NextResponse.json(cached);

    const { meta, assetCtxs } = await getMetaAndCtxs();

    const macros: MacroData[] = MACRO_INDICATORS.map((m) => {
      if (m.source === "live") {
        const idx = meta.universe.findIndex((u) => u.name === m.symbol);
        if (idx >= 0) {
          const ctx = assetCtxs[idx];
          let price = parseFloat(ctx.markPx || "0");
          let prevDay = parseFloat(ctx.prevDayPx || "0");
          // SPX perp is fractional on Hyperliquid (~0.287 = SPX/20000), scale it
          if (m.symbol === "SPX") {
            price = price * 20000;
            prevDay = prevDay * 20000;
          }
          const change = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : null;
          return { symbol: m.symbol, label: m.label, value: price, change, source: "live" as const };
        }
      }
      // Static placeholder
      return { symbol: m.symbol, label: m.label, value: null, change: null, source: "static" as const };
    });

    cache.set("api:macro", macros, 60_000);
    return NextResponse.json(macros);
  } catch (err) {
    const stale = cache.getStale<MacroData[]>("api:macro");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

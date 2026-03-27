import { NextResponse } from "next/server";
import { getMetaAndCtxs, getCandles } from "@/lib/hyperliquid";
import { HL_PERP_SECTOR_MAP } from "@/config/sectors";
import { detectSignals, Signal } from "@/lib/signals";
import { cache } from "@/lib/cache";

export async function GET() {
  try {
    const cached = cache.get<Signal[]>("api:signals");
    if (cached) return NextResponse.json(cached);

    const { meta, assetCtxs } = await getMetaAndCtxs();
    const allSignals: Signal[] = [];

    // Process top perps by volume for signals
    const mapped = meta.universe
      .map((u, i) => ({ name: u.name, ctx: assetCtxs[i] }))
      .filter((a) => HL_PERP_SECTOR_MAP[a.name])
      .sort((a, b) => parseFloat(b.ctx.dayNtlVlm) - parseFloat(a.ctx.dayNtlVlm))
      .slice(0, 40); // Top 40 by volume

    // Fetch candles in batches of 5
    for (let i = 0; i < mapped.length; i += 5) {
      const batch = mapped.slice(i, i + 5);
      const candleResults = await Promise.all(
        batch.map((a) => getCandles(a.name, "4h", 350).catch(() => []))
      );

      for (let j = 0; j < batch.length; j++) {
        const candles = candleResults[j];
        if (candles.length < 30) continue;

        const closes = candles.map((c) => parseFloat(c.c));
        const volumes = candles.map((c) => parseFloat(c.v));
        const highs = candles.map((c) => parseFloat(c.h));
        const lows = candles.map((c) => parseFloat(c.l));
        const funding = parseFloat(batch[j].ctx.funding || "0");

        const signals = detectSignals(batch[j].name, closes, volumes, highs, lows, funding);
        allSignals.push(...signals);
      }
    }

    allSignals.sort((a, b) => b.firedAt - a.firedAt);
    cache.set("api:signals", allSignals, 30_000);
    return NextResponse.json(allSignals);
  } catch (err) {
    const stale = cache.getStale<Signal[]>("api:signals");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

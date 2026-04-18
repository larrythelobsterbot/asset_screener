import { NextResponse } from "next/server";
import { getMetaAndCtxs, getCandles, getFundingHistory } from "@/lib/hyperliquid";
import { HL_PERP_SECTOR_MAP } from "@/config/sectors";
import { detectSignals, detectSectorRelativeStrength, Signal, type SectorSnapshot } from "@/lib/signals";
import { cache } from "@/lib/cache";
import { logSignalFires } from "@/lib/signalPersistence";

// Per-scan per-coin failure counts, so we can see at a glance whether a
// fetch layer is degrading rather than silently swallowing errors.
interface ScanFailure {
  symbol: string;
  stage: "candles" | "funding";
  message: string;
}

export async function GET() {
  try {
    const cached = cache.get<Signal[]>("api:signals");
    if (cached) return NextResponse.json(cached);

    const { meta, assetCtxs } = await getMetaAndCtxs();
    const allSignals: Signal[] = [];
    const failures: ScanFailure[] = [];

    // Process top perps by volume for signals
    const mapped = meta.universe
      .map((u, i) => ({ name: u.name, ctx: assetCtxs[i] }))
      .filter((a) => HL_PERP_SECTOR_MAP[a.name])
      .sort((a, b) => parseFloat(b.ctx.dayNtlVlm) - parseFloat(a.ctx.dayNtlVlm))
      .slice(0, 40); // Top 40 by volume

    // Cross-sectional pass: build a sector snapshot from *all* mapped perps
    // (not just the top-40) so the sector medians reflect the full sector
    // behaviour, not just the high-volume subset. Sector-RS signals are
    // then filtered down to the top-40 symbols below.
    const fullSnapshot: SectorSnapshot[] = meta.universe
      .map((u, i) => ({ u, ctx: assetCtxs[i] }))
      .filter((a) => HL_PERP_SECTOR_MAP[a.u.name])
      .map(({ u, ctx }) => {
        const price = parseFloat(ctx.markPx || "0");
        const prevDay = parseFloat(ctx.prevDayPx || "0");
        const change24h = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : null;
        return {
          symbol: u.name,
          sector: HL_PERP_SECTOR_MAP[u.name].sector,
          change24h,
        };
      });
    const topSymbols = new Set(mapped.map((m) => m.name));
    const sectorSignals = detectSectorRelativeStrength(fullSnapshot).filter((s) =>
      topSymbols.has(s.symbol)
    );
    allSignals.push(...sectorSignals);

    // Multi-timeframe scan: we run the full signal detector on 1h, 4h, and
    // 1d bars for each symbol. The 4h pass is the most important (matches
    // the legacy behaviour and the primary trading horizon for most
    // consumers), so it uses the longest history. 1h gives us near-term
    // texture for the bot; 1d anchors the structural trend.
    //
    // API budget: 3 candle fetches + 1 funding fetch per symbol = 4 × 40
    // = 160 calls per scan. With the 10 req/s HL rate limiter that's a
    // ~16 s worst-case scan, comfortably inside the 30 s route cache.
    const TIMEFRAMES: { tf: import("@/lib/signals").Timeframe; interval: "1h" | "4h" | "1d"; bars: number }[] = [
      { tf: "1h", interval: "1h", bars: 200 },
      { tf: "4h", interval: "4h", bars: 350 },
      { tf: "1d", interval: "1d", bars: 300 },
    ];

    for (let i = 0; i < mapped.length; i += 5) {
      const batch = mapped.slice(i, i + 5);

      // Fetch all three timeframes + funding history concurrently for the
      // batch. Each inner Promise.all is bounded by the rate limiter, so
      // we don't overrun HL even though the flat count is high.
      const [fundingResults, ...tfResults] = await Promise.all([
        Promise.all(
          batch.map((a) =>
            getFundingHistory(a.name, 168).catch((err: unknown) => {
              failures.push({ symbol: a.name, stage: "funding", message: String(err) });
              return [];
            })
          )
        ),
        ...TIMEFRAMES.map((tfSpec) =>
          Promise.all(
            batch.map((a) =>
              getCandles(a.name, tfSpec.interval, tfSpec.bars).catch((err: unknown) => {
                failures.push({ symbol: a.name, stage: "candles", message: `${tfSpec.tf}: ${String(err)}` });
                return [];
              })
            )
          )
        ),
      ]);

      for (let j = 0; j < batch.length; j++) {
        const funding = parseFloat(batch[j].ctx.funding || "0");
        const fundingHist = fundingResults[j]
          .map((f) => parseFloat(f.fundingRate))
          .filter((x) => Number.isFinite(x));

        for (let t = 0; t < TIMEFRAMES.length; t++) {
          const candles = tfResults[t][j];
          if (candles.length < 30) continue;
          const closes = candles.map((c) => parseFloat(c.c));
          const volumes = candles.map((c) => parseFloat(c.v));
          const highs = candles.map((c) => parseFloat(c.h));
          const lows = candles.map((c) => parseFloat(c.l));

          // Only the 4h pass gets the funding rate — funding is a 1h-cadence
          // metric and doesn't meaningfully vary across the TF scans, so we
          // avoid firing the same anomaly 3× per scan.
          const isPrimary = TIMEFRAMES[t].tf === "4h";

          const signals = detectSignals(
            batch[j].name,
            closes,
            volumes,
            highs,
            lows,
            isPrimary ? funding : undefined,
            isPrimary ? fundingHist : undefined,
            TIMEFRAMES[t].tf
          );
          allSignals.push(...signals);
        }
      }
    }

    // Circuit-breaker warning: if >20% of the scanned universe failed on
    // either stage, surface it in logs instead of quietly serving degraded
    // data. Downstream consumers still get whatever did succeed.
    const failureRate = failures.length / Math.max(1, mapped.length * 2);
    if (failureRate > 0.2) {
      console.warn(
        `[signals] high failure rate: ${failures.length}/${mapped.length * 2} fetches failed ` +
          `(${(failureRate * 100).toFixed(0)}%) — sample: ${failures
            .slice(0, 5)
            .map((f) => `${f.symbol}:${f.stage}`)
            .join(",")}`
      );
    }

    allSignals.sort((a, b) => b.firedAt - a.firedAt);

    // Fire-and-forget persistence: we pass the current mark price per symbol
    // so the outcome evaluator can compute pnl later. The call no-ops if
    // Supabase env vars aren't set, so this is safe to leave in unconditionally.
    const priceBySymbol = new Map<string, number>();
    for (let i = 0; i < meta.universe.length; i++) {
      const sym = meta.universe[i].name;
      const px = parseFloat(assetCtxs[i].markPx || "0");
      if (px > 0) priceBySymbol.set(sym, px);
    }
    logSignalFires(allSignals, priceBySymbol).catch((e) =>
      console.warn("[signals] persistence error:", e)
    );

    cache.set("api:signals", allSignals, 30_000);
    return NextResponse.json(allSignals);
  } catch (err) {
    const stale = cache.getStale<Signal[]>("api:signals");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

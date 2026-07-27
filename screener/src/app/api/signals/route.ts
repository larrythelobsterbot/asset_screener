import { NextResponse } from "next/server";
import { getMetaAndCtxs, getCandles, getFundingHistory, displayScaleOf } from "@/lib/hyperliquid";
import { HL_PERP_SECTOR_MAP } from "@/config/sectors";
import {
  detectSignals,
  detectSectorRelativeStrengthMulti,
  detectSocialSpike,
  deriveVolRegime,
  filterClosedCandles,
  Signal,
  type SectorMultiSnapshot,
  type SocialSnapshot,
} from "@/lib/signals";
import { cache } from "@/lib/cache";
import { logSignalFires } from "@/lib/signalPersistence";
import { snapshotAtBounded, latestSocialSnapshots } from "@/lib/db";
import { maybeDispatchAlerts, type TradeContext } from "@/lib/alerter";
import { atrPercent, type VolRegime } from "@/lib/indicators";

// Without this, Next App Router may prerender this route statically at build time
// and serves a frozen snapshot forever. See markets/route.ts for the same
// fix. All routes that read live market data must opt out of static gen.
export const dynamic = "force-dynamic";

// Browser polling and the visitor-independent instrumentation keepalive can
// arrive on different phases. Keep results fresh for almost one minute so
// both consumers share one expensive 160-call scan instead of alternating
// scans every ~30 seconds; getWithRefresh still single-flights boundary races.
const SIGNAL_CACHE_TTL_MS = 55_000;

// Per-scan per-coin failure counts, so we can see at a glance whether a
// fetch layer is degrading rather than silently swallowing errors.
interface ScanFailure {
  symbol: string;
  stage: "candles" | "funding";
  message: string;
}

async function scanSignals(): Promise<Signal[]> {
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
    //
    // Multi-horizon: 24h comes from HL's prevDayPx; 1h and 4h come from
    // SQLite snapshots taken on prior /api/markets scans. On cold-start
    // (DB just initialised) those horizons return empty and the multi-RS
    // function silently skips them — degrades to 24h-only, same as legacy.
    const mappedUniverse = meta.universe
      .map((u, i) => ({ u, ctx: assetCtxs[i] }))
      .filter((a) => HL_PERP_SECTOR_MAP[a.u.name]);
    const allMappedSymbols = mappedUniverse.map((a) => a.u.name);

    const now = Date.now();
    // Bounded snapshot lookups: reject rows older than the tolerance so
    // an extended downtime (when snapshots are sparse) can't accidentally
    // pair a now-price with a snapshot from days ago — that would compute
    // nonsense % changes downstream.
    //   - 1h horizon → 30min tolerance (snapshot 30–90min ago acceptable)
    //   - 4h horizon → 1h tolerance (snapshot 3–5h ago acceptable)
    // Symbols with no fresh-enough snapshot simply don't get a change1h /
    // change4h value, which the sector-RS pass handles gracefully.
    const TOLERANCE_1H = 30 * 60_000;
    const TOLERANCE_4H = 60 * 60_000;
    const snap1hAgo = snapshotAtBounded(now - 3_600_000, TOLERANCE_1H, allMappedSymbols);
    const snap4hAgo = snapshotAtBounded(now - 4 * 3_600_000, TOLERANCE_4H, allMappedSymbols);

    const fullSnapshot: SectorMultiSnapshot[] = mappedUniverse.map(({ u, ctx }) => {
      // Snapshot marks are stored in DISPLAY units (/api/markets scales
      // before insertPriceSnapshots), so the live side of the 1h/4h
      // comparison must be display-scaled too. Without this, SPX (raw
      // ~0.37 vs stored ~7400) computed change1h/4h ≈ -99.995% every
      // scan and fed it to the indices sector stats — the old comment
      // below claimed off-scale rows were skipped, but the guard only
      // ever checked p > 0. The 24h ratio is scale-invariant (both
      // factors scaled identically), so this changes nothing for it.
      const scale = displayScaleOf(u.name);
      const price = parseFloat(ctx.markPx || "0") * scale;
      const prevDay = parseFloat(ctx.prevDayPx || "0") * scale;
      const change24h = prevDay > 0 ? ((price - prevDay) / prevDay) * 100 : null;
      const p1h = snap1hAgo.get(u.name);
      const p4h = snap4hAgo.get(u.name);
      const change1h = p1h && p1h > 0 ? ((price - p1h) / p1h) * 100 : null;
      const change4h = p4h && p4h > 0 ? ((price - p4h) / p4h) * 100 : null;
      return {
        symbol: u.name,
        sector: HL_PERP_SECTOR_MAP[u.name].sector,
        change1h,
        change4h,
        change24h,
      };
    });
    const topSymbols = new Set(mapped.map((m) => m.name));
    const sectorSignals = detectSectorRelativeStrengthMulti(fullSnapshot).filter((s) =>
      topSymbols.has(s.symbol)
    );
    allSignals.push(...sectorSignals);

    // Cross-sectional social spike pass — reads from SQLite social_snapshots
    // populated hourly by /api/social/trending. Zero Elfa cost: this is a
    // pure local read. Filter results to the top-40 symbols so we don't
    // alert on long-tail tickers that aren't tradable on HL anyway.
    try {
      // social_spike fires on 24h mention growth — match the time
      // window the poller is writing to (default tf=24h on /api/social/trending).
      const socialMap = latestSocialSnapshots("24h", allMappedSymbols);
      const socialSnapshot: SocialSnapshot[] = [];
      for (const sym of allMappedSymbols) {
        const row = socialMap.get(sym);
        if (!row) continue;
        socialSnapshot.push({
          symbol: sym,
          mention_count: row.mention_count,
          prev_count: row.prev_count,
          change_pct: row.change_pct,
        });
      }
      const socialSignals = detectSocialSpike(socialSnapshot).filter((s) =>
        topSymbols.has(s.symbol)
      );
      allSignals.push(...socialSignals);
      if (socialSignals.length > 0) {
        console.info(
          `[signals] social_spike fired on: ${socialSignals.map((s) => s.symbol).join(", ")}`
        );
      }
    } catch (err) {
      // Social is optional context — never block the scan if SQLite is
      // unavailable or the social table is empty (cold-start case).
      console.warn("[signals] social_spike read failed:", err);
    }

    // Multi-timeframe scan: we run the full signal detector on 1h, 4h, and
    // 1d bars for each symbol. The 4h pass is the most important (matches
    // the legacy behaviour and the primary trading horizon for most
    // consumers), so it uses the longest history. 1h gives us near-term
    // texture for the bot; 1d anchors the structural trend.
    //
    // API budget: 3 candle fetches + 1 funding fetch per symbol = 4 × 40
    // = 160 calls per scan. With the 10 req/s HL rate limiter that's a
    // ~16 s worst-case scan, comfortably inside the route cache window.
    const TIMEFRAMES: { tf: import("@/lib/signals").Timeframe; interval: "1h" | "4h" | "1d"; bars: number }[] = [
      { tf: "1h", interval: "1h", bars: 200 },
      { tf: "4h", interval: "4h", bars: 350 },
      { tf: "1d", interval: "1d", bars: 300 },
    ];

    // Trade context per symbol — populated from the 4h pass (the primary
    // timeframe the LTF playbook trades). ATR% drives the stop distance
    // in the Telegram trade card; fundingHourly tags the alert with
    // long/short alignment. Built here so the alerter doesn't have to
    // recompute anything from raw candles.
    const tradeCtxBySymbol = new Map<string, TradeContext>();
    const primaryVolRegimeBySymbol = new Map<string, VolRegime>(
      mapped.map((asset) => [asset.name, "unknown"]),
    );
    const decisionCandleAtBySymbol = new Map<string, number>();
    const candleDecisionCutoff = Date.now();

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
          const candles = filterClosedCandles(tfResults[t][j], candleDecisionCutoff);
          const isPrimary = TIMEFRAMES[t].tf === "4h";
          if (isPrimary && candles.length > 0) {
            decisionCandleAtBySymbol.set(batch[j].name, candles[candles.length - 1].T);
          }
          if (candles.length < 30) continue;
          const closes = candles.map((c) => parseFloat(c.c));
          const volumes = candles.map((c) => parseFloat(c.v));
          const highs = candles.map((c) => parseFloat(c.h));
          const lows = candles.map((c) => parseFloat(c.l));

          // Only the 4h pass gets the funding rate — funding is a 1h-cadence
          // metric and doesn't meaningfully vary across the TF scans, so we
          // avoid firing the same anomaly 3× per scan.
          if (isPrimary) {
            primaryVolRegimeBySymbol.set(
              batch[j].name,
              deriveVolRegime(highs, lows, closes),
            );
          }

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

          // Stamp 4h ATR% + funding into the trade-context map for the
          // alerter. We only fill from the 4h pass — that's the timeframe
          // the trade card sizes against. Skip if ATR is null (insufficient
          // history): the alerter will just omit the trade card.
          if (isPrimary) {
            const atrSeries = atrPercent(highs, lows, closes, 14);
            const atrLast = atrSeries[atrSeries.length - 1];
            if (atrLast != null && Number.isFinite(atrLast) && atrLast > 0) {
              tradeCtxBySymbol.set(batch[j].name, {
                atrPct: atrLast,
                fundingHourly: Number.isFinite(funding) ? funding : undefined,
              });
            }
          }
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
      const px = parseFloat(assetCtxs[i].markPx || "0") * displayScaleOf(sym);
      if (px > 0) priceBySymbol.set(sym, px);
    }
    logSignalFires(allSignals, priceBySymbol).catch((e) =>
      console.warn("[signals] persistence error:", e)
    );

    // Telegram alerting — fire-and-forget. Scores conviction per symbol
    // and dispatches Strong Buy/Sell alerts that pass the cooldown +
    // vol-regime gate. No-ops if env isn't configured.
    maybeDispatchAlerts(
      allSignals,
      priceBySymbol,
      tradeCtxBySymbol,
      primaryVolRegimeBySymbol,
      decisionCandleAtBySymbol,
      candleDecisionCutoff,
    )
      .then((r) => {
        if (r.considered > 0) {
          console.info(
            `[alerter] considered=${r.considered} fired=${r.fired} ` +
            `activeThesis=${r.activeThesis} cooledDown=${r.cooledDown} ` +
            `failed=${r.failed} unknown=${r.unknown}`
          );
        }
      })
      .catch((e) => console.warn("[alerter] dispatch error:", e));

    return allSignals;
}

export async function GET() {
  // Instrumentation pings this route independently of browser traffic.
  try {
    const signals = await cache.getWithRefresh("api:signals", scanSignals, SIGNAL_CACHE_TTL_MS, 120_000);
    return NextResponse.json(signals);
  } catch (err) {
    const stale = cache.getStale<Signal[]>("api:signals");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

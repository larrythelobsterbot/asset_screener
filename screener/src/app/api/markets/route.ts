import { NextResponse } from "next/server";
import { getMetaAndCtxs, getBuilderDexData, displayScaleOf, rawPriceOf } from "@/lib/hyperliquid";
import { getMarkets } from "@/lib/coingecko";
import { HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP, BUILDER_DEXES, SECTORS, Sector } from "@/config/sectors";
import { AssetData } from "@/lib/types";
import { cache } from "@/lib/cache";
import {
  insertPriceSnapshots,
  startPruneJob,
  snapshotAtBounded,
  snapshotFullAtBounded,
  avgFundingSince,
  getCandlesBulkFromCache,
  type PriceSnapshotRow,
} from "@/lib/db";
import { startHlWs, getMid } from "@/lib/hyperliquidWs";
import { startHip3CandleWarmer } from "@/lib/hip3CandleWarmer";

// Kick the periodic prune job once per process. Idempotent — repeated
// calls are no-ops. This is the natural place to hook startup because
// /api/markets is the most-hit route, so the prune timer is alive
// shortly after process boot.
startPruneJob();

// Same idempotent-init pattern for the WS mid stream. The connection
// stays alive for the process lifetime; reconnects on its own. Started
// here (rather than at module top-level somewhere generic) because this
// route is hit early enough that the connection is established before
// the first request needs it.
startHlWs();

// Same idempotent-init pattern: keeps candles_cache warm for the HIP-3
// board, which no other job fetches candles for. Self-schedules every 6h.
startHip3CandleWarmer();

// Without this, Next.js 14 App Router prerenders this route at BUILD TIME
// and the built-in response gets served forever — meaning every price in
// the response is frozen to whatever Hyperliquid returned during the build
// step. `force-dynamic` makes Next.js evaluate the handler on every request
// so our in-memory TTL cache is what actually controls freshness.
export const dynamic = "force-dynamic";


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
    // Time-series snapshot rows accumulated alongside the response shape.
    // We collect raw HL data here (closest to the source) rather than
    // re-deriving from AssetData later, which avoids the markPrice/change24h
    // round-trip floating-point loss.
    const snapshotTs = Date.now();
    const snapshotRows: PriceSnapshotRow[] = [];

    // ALL Hyperliquid perps — use sector map if available, otherwise auto-classify
    const { meta, assetCtxs } = hlData;
    for (let i = 0; i < meta.universe.length; i++) {
      const name = meta.universe[i].name;
      const ctx = assetCtxs[i];

      let price = parseFloat(ctx.markPx || "0");
      let prevDayPx = parseFloat(ctx.prevDayPx || "0");
      // Overlay the live WS mid when we have one. WS mids tick in real
      // time; the REST markPx is up to 30s stale by the time we read it.
      // For an LTF user clicking a tile, this difference is the gap
      // between "real entry price" and "phantom price they can't actually
      // hit." getMid returns null when the WS is connecting/disconnected
      // or the value is too stale, in which case we keep the REST mark.
      const liveMid = getMid(name);
      if (liveMid != null && liveMid > 0) price = liveMid;
      // Scale fractionally-quoted markets up to their familiar level (see
      // PRICE_DISPLAY_SCALE). Applies to both REST and WS sources since
      // allMids returns the same un-scaled value.
      const scale = displayScaleOf(name);
      if (scale !== 1) { price *= scale; prevDayPx *= scale; }
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

      const fundingRate = parseFloat(ctx.funding || "0");
      const openInterest = parseFloat(ctx.openInterest || "0");
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
        fundingRate,
        openInterest,
        markPrice: price,
        oraclePrice: parseFloat(ctx.oraclePx || "0"),
        source: "hyperliquid",
        // Flow metrics are filled by the backfill pass below.
        oiUsd: null,
        oiChange24hUsd: null,
        oiChange24hPct: null,
        oiChange7dUsd: null,
        oiChange7dPct: null,
        fundingAvg24h: null,
        volOiRatio: null,
      });
      snapshotRows.push({
        symbol: name,
        ts: snapshotTs,
        mark: price,
        prev_day: prevDayPx > 0 ? prevDayPx : null,
        funding: fundingRate,
        oi: openInterest,
        volume,
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

        const fundingRate = parseFloat(ctx.funding || "0");
        const openInterest = parseFloat(ctx.openInterest || "0");
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
          fundingRate,
          openInterest,
          markPrice: price,
          oraclePrice: parseFloat(ctx.oraclePx || "0"),
          source: "hyperliquid",
          // Flow metrics are filled by the backfill pass below.
          oiUsd: null,
          oiChange24hUsd: null,
          oiChange24hPct: null,
          oiChange7dUsd: null,
          oiChange7dPct: null,
          fundingAvg24h: null,
          volOiRatio: null,
        });
        snapshotRows.push({
          symbol: ticker,
          ts: snapshotTs,
          mark: price,
          prev_day: prevDayPx > 0 ? prevDayPx : null,
          funding: fundingRate,
          oi: openInterest,
          volume,
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
        // CoinGecko rows have no perp context — no OI, no funding. These
        // stay null permanently; the UI renders them as em-dashes.
        oiUsd: null,
        oiChange24hUsd: null,
        oiChange24hPct: null,
        oiChange7dUsd: null,
        oiChange7dPct: null,
        fundingAvg24h: null,
        volOiRatio: null,
      });
    }

    // ── Backfill change% + flow metrics from local data ───────────────
    // No new HL calls. Sources:
    //   change1h  ← price_snapshots taken 1h ago by a prior scan
    //   change4h  ← price_snapshots taken 4h ago
    //   change7d  ← 1d candles from candles_cache (populated by signals + modal),
    //               falling back to price_snapshots taken ~7d ago for symbols
    //               with no cached candles (all HIP-3 builder perps)
    //   OI deltas ← price_snapshots at 24h / 7d ago (oi × mark, same row)
    //   fundingAvg24h ← mean of funding over the last 24h of snapshots
    // Missing data leaves the field at null — same as before this change.
    // On cold start (first hour after first deploy) all three will be null
    // for everything; the heatmap already handles null gracefully.
    const hlSymbolsForBackfill = assets
      .filter((a) => a.source === "hyperliquid")
      .map((a) => a.symbol);
    // Bounded — reject snapshots more than 30min (1h horizon) / 1h (4h
    // horizon) off the target. After downtime, an unbounded lookup
    // could pair the live price with a row from days ago and ship a
    // garbage % change to the UI.
    const snap1h = snapshotAtBounded(snapshotTs - 3_600_000, 30 * 60_000, hlSymbolsForBackfill);
    const snap4h = snapshotAtBounded(snapshotTs - 4 * 3_600_000, 60 * 60_000, hlSymbolsForBackfill);
    // 24h/7d full snapshots — mark + oi + funding from a single row each,
    // which is what makes the USD OI delta trustworthy: OI is denominated
    // in coins, so it must be multiplied by the mark *from its own row*.
    // Pairing a historical OI with today's price would report a delta that
    // is really just the price move.
    //
    // The 7d row also serves as the change7d fallback for symbols without
    // cached 1d candles (the signals job only warms candles_cache for the
    // crypto screener set, so HIP-3 builder perps never get a candle-based
    // 7d). ±6h tolerance is ≈3.6% of the horizon — generous, but still
    // rejects stale rows after downtime.
    const full24h = snapshotFullAtBounded(snapshotTs - 24 * 3_600_000, 2 * 3_600_000, hlSymbolsForBackfill);
    const full7d = snapshotFullAtBounded(snapshotTs - 7 * 86_400_000, 6 * 3_600_000, hlSymbolsForBackfill);
    const avgFunding24h = avgFundingSince(snapshotTs - 24 * 3_600_000, hlSymbolsForBackfill);
    // Bulk-read 1d candles for ALL HL symbols in one SQLite query.
    // Previously this was 230+ synchronous queries inside the asset
    // loop — measurably blocking the event loop on each markets scan.
    let dailiesBySymbol = new Map<string, Array<{ c: number }>>();
    try {
      const bulk = getCandlesBulkFromCache(hlSymbolsForBackfill, "1d", 10);
      // We only need the close field downstream; preserve the shape.
      dailiesBySymbol = new Map(
        [...bulk.entries()].map(([s, rows]) => [s, rows.map((r) => ({ c: r.c }))])
      );
    } catch (err) {
      console.warn(`[markets] bulk 1d candle read failed:`, err);
    }
    for (const a of assets) {
      if (a.source !== "hyperliquid") continue;
      const p1 = snap1h.get(a.symbol);
      const p4 = snap4h.get(a.symbol);
      if (p1 && p1 > 0) a.change1h = ((a.price - p1) / p1) * 100;
      if (p4 && p4 > 0) a.change4h = ((a.price - p4) / p4) * 100;
      // 7d: 1d candles oldest-first. The last bar is "today (in progress)"
      // so the close 7 bars ago is candles[length - 8]. Need at least 8.
      const dailies = dailiesBySymbol.get(a.symbol) ?? [];
      // candles_cache holds HL's RAW quote, so a fractionally-quoted market
      // (SPX) must be scaled into display units before it can be compared
      // against a.price — unscaled, its change7d reads ~2,000,000%. Scaling
      // rather than skipping keeps every market on one code path.
      const candleScale = displayScaleOf(a.symbol);
      if (dailies.length >= 8) {
        const sevenAgo = dailies[dailies.length - 8].c * candleScale;
        if (sevenAgo > 0) a.change7d = ((a.price - sevenAgo) / sevenAgo) * 100;
      }
      const prior7d = full7d.get(a.symbol);
      if (a.change7d == null) {
        const p7 = prior7d?.mark;
        if (p7 && p7 > 0) a.change7d = ((a.price - p7) / p7) * 100;
      }

      // ── Flow metrics ────────────────────────────────────────────────
      // openInterest is in coins, so it pairs with the RAW quote price, not
      // the display price — see PRICE_DISPLAY_SCALE.
      const oiUsd =
        a.openInterest != null && a.openInterest > 0
          ? a.openInterest * rawPriceOf(a.symbol, a.price)
          : null;
      a.oiUsd = oiUsd;
      if (oiUsd != null && oiUsd > 0) {
        a.volOiRatio = a.volume24h / oiUsd;
        for (const [prior, usdKey, pctKey] of [
          [full24h.get(a.symbol), "oiChange24hUsd", "oiChange24hPct"],
          [prior7d, "oiChange7dUsd", "oiChange7dPct"],
        ] as const) {
          // Both factors from the same historical row — see the comment on
          // the snapshotFullAtBounded calls above.
          if (prior?.oi == null || prior.mark <= 0) continue;
          const priorOiUsd = prior.oi * rawPriceOf(a.symbol, prior.mark);
          if (priorOiUsd <= 0) continue;
          a[usdKey] = oiUsd - priorOiUsd;
          a[pctKey] = ((oiUsd - priorOiUsd) / priorOiUsd) * 100;
        }
      }
      const fAvg = avgFunding24h.get(a.symbol);
      if (fAvg != null) a.fundingAvg24h = fAvg;
    }

    cache.set("api:markets", assets, 30_000);

    // Fire-and-forget time-series snapshot. Only HL-sourced rows are
    // captured (assembled in the perp + builder-dex loops above) — we
    // don't dilute the table with CG rows that lack OI/funding.
    // setImmediate keeps the SQLite write strictly off the response's
    // critical path; a ~230-row transaction in WAL mode runs in single-
    // digit ms so this is a defensive measure rather than a hot fix.
    setImmediate(() => {
      try {
        insertPriceSnapshots(snapshotRows);
      } catch (err) {
        console.warn(`[markets] snapshot insert failed:`, err);
      }
    });

    return NextResponse.json(assets, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "CDN-Cache-Control": "no-store" },
    });
  } catch (err) {
    const stale = cache.getStale<AssetData[]>("api:markets");
    if (stale) return NextResponse.json(stale);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

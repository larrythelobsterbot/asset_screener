import { NextResponse } from "next/server";
import { getMetaAndCtxs, getBuilderDexData } from "@/lib/hyperliquid";
import { getMarkets } from "@/lib/coingecko";
import { HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP, BUILDER_DEXES, SECTORS, Sector } from "@/config/sectors";
import { AssetData } from "@/lib/types";
import { cache } from "@/lib/cache";
import {
  insertPriceSnapshots,
  startPruneJob,
  snapshotAtBounded,
  getCandlesBulkFromCache,
  type PriceSnapshotRow,
} from "@/lib/db";
import { startHlWs, getMid } from "@/lib/hyperliquidWs";

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
      // HL's SPX perp is quoted as (index / 20000) — i.e. 1 unit = 1/20000th
      // of the S&P 500 index level — so we scale back up here to display a
      // number that matches the familiar SPX value (e.g. 5200, not 0.26).
      // This multiplier is specific to HL's SPX contract; if they ever list
      // an un-scaled SPX market (or rename this one) this branch becomes
      // wrong and should be revisited. Applies to both REST and WS sources
      // since allMids returns the same un-scaled value.
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
      });
    }

    // ── Backfill 1h / 4h / 7d change% from local data ─────────────────
    // No new HL calls. Sources:
    //   change1h  ← price_snapshots taken 1h ago by a prior scan
    //   change4h  ← price_snapshots taken 4h ago
    //   change7d  ← 1d candles from candles_cache (populated by signals + modal)
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
      if (dailies.length >= 8) {
        const sevenAgo = dailies[dailies.length - 8].c;
        if (sevenAgo > 0) a.change7d = ((a.price - sevenAgo) / sevenAgo) * 100;
      }
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

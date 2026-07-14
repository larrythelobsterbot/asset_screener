// HL-native derivs radar (v2). Replaces the Coinalyze-backed version.
//
// Why: Coinalyze's free quota proved unusable for sustained polling, and
// Binance/Bybit public APIs geo-block this VPS's US IP. But the screener
// has been writing Hyperliquid mark/OI/funding for EVERY perp into
// price_snapshots at ~60s cadence since launch — which is exactly the
// time series the OI×Price regime read needs. So the radar is computed
// on demand from our own SQLite: no external API, no quota, no geo-block.
// (HL is the venue whose positioning the user trades against anyway.)
//
// HL specifics: assetCtxs.openInterest is denominated in COINS — multiply
// by mark for USD. assetCtxs.funding is the live hourly rate (decimal).

import { getMetaAndCtxs, getBuilderDexData, displayScaleOf, rawPriceOf } from "./hyperliquid";
import { snapshotSeriesBulk } from "./db";
import { classifyRegime } from "./coinalyzePoller";
import { BUILDER_DEXES, HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP } from "@/config/sectors";

// Top-N by 24h notional across native AND builder-deployed (HIP-3) perps.
// 100 rather than 30 because the HIP-3 board now trades more volume than
// the crypto side of the exchange, and because the mean-reversion
// candidates live in the mid-cap tail that a top-30 cut never reached.
// snapshotSeriesBulk over a 1h window for 100 symbols is ~6k rows; don't
// widen further without measuring — this route recomputes every 20s.
const TOP_N = 100;
const LOOKBACK_MS = 15 * 60_000;      // regime delta window
const SPARK_WINDOW_MS = 60 * 60_000;  // sparkline history window
const SPARK_POINTS = 40;              // max points sent to the client
// The lookback row must sit reasonably close to the target time. With a
// healthy 60s snapshot cadence the nearest row is seconds away; if the
// best match is > 6min off target (cold start, snapshot gap) the delta
// would be mislabeled — return null instead and let the UI show warm-up.
const LOOKBACK_TOLERANCE_MS = 6 * 60_000;

export interface HlDerivsItem {
  base: string;
  price: number;
  priceDeltaPct: number | null;  // vs 15m ago
  oiUsd: number;                  // HL open interest in USD
  oiDeltaPct: number | null;      // vs 15m ago
  fundingHourly: number | null;   // live HL hourly funding rate (decimal)
  regime: string;
  spark: { px: number[]; oi: number[] }; // last hour, normalized later by UI
  volume24h: number;
  dex: string | null;             // builder dex that lists it; null = native HL
  sector: string | null;
}

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const step = values.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(values[Math.floor(i * step)]);
  out[out.length - 1] = values[values.length - 1]; // always end on the latest
  return out;
}

export async function computeHlDerivs(): Promise<HlDerivsItem[]> {
  const [{ meta, assetCtxs }, ...builderResults] = await Promise.all([
    getMetaAndCtxs(),
    ...BUILDER_DEXES.map((dex) => getBuilderDexData(dex).catch(() => null)),
  ]);
  const now = Date.now();

  // Merge native + builder-deployed perps into one candidate list, keyed by
  // BARE ticker — that's how /api/markets writes price_snapshots, so the
  // snapshotSeriesBulk lookups below only line up if we key the same way.
  //
  // Dedup precedence must match /api/markets exactly (native wins, then
  // earlier dex in BUILDER_DEXES), otherwise the same ticker could resolve
  // to a different venue's contract here than in the table, and the two
  // views would quietly disagree about the same row.
  type Candidate = {
    base: string;
    ctx: (typeof assetCtxs)[number];
    vol: number;
    dex: string | null;
    sector: string | null;
  };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < meta.universe.length; i++) {
    const base = meta.universe[i].name;
    const ctx = assetCtxs[i];
    const vol = parseFloat(ctx?.dayNtlVlm || "0");
    if (!ctx || !(vol > 0)) continue;
    seen.add(base);
    candidates.push({ base, ctx, vol, dex: null, sector: HL_PERP_SECTOR_MAP[base]?.sector ?? null });
  }

  for (let d = 0; d < BUILDER_DEXES.length; d++) {
    const dex = BUILDER_DEXES[d];
    const data = builderResults[d];
    if (!data) continue;
    for (let i = 0; i < data.meta.universe.length; i++) {
      const raw = data.meta.universe[i].name; // "xyz:TSLA" or "TSLA"
      const ticker = raw.includes(":") ? raw.split(":")[1] : raw;
      if (seen.has(ticker)) continue; // native, or an earlier dex, already took it
      const ctx = data.assetCtxs[i];
      const vol = parseFloat(ctx?.dayNtlVlm || "0");
      if (!ctx || !(vol > 0)) continue; // skip ghost listings
      seen.add(ticker);
      candidates.push({
        base: ticker,
        ctx,
        vol,
        dex,
        sector: HL_BUILDER_PERP_MAP[`${dex}:${ticker}`]?.sector ?? null,
      });
    }
  }

  // Top-N by 24h notional volume — where the leveraged flow is.
  const universe = candidates.sort((a, b) => b.vol - a.vol).slice(0, TOP_N);

  const series = snapshotSeriesBulk(
    universe.map((r) => r.base),
    now - SPARK_WINDOW_MS
  );

  const items: HlDerivsItem[] = [];
  for (const { base, ctx, vol, dex, sector } of universe) {
    // Work in DISPLAY units throughout: price_snapshots stores the scaled
    // mark, so a raw markPx here would compare 0.37 against 7407 for SPX
    // and report a -99.99% move. USD OI divides the scale back out (see
    // rawPriceOf) since openInterest is coin-denominated.
    const rawMark = parseFloat(ctx.markPx || "0");
    const mark = rawMark * displayScaleOf(base);
    const oiCoins = parseFloat(ctx.openInterest || "0");
    if (!Number.isFinite(mark) || mark <= 0) continue;
    const oiUsd = oiCoins * rawPriceOf(base, mark);

    const hist = series.get(base) ?? [];
    // Closest snapshot to the 15m-ago target, within tolerance.
    const target = now - LOOKBACK_MS;
    let prior: (typeof hist)[number] | null = null;
    let bestDist = Infinity;
    for (const h of hist) {
      const d = Math.abs(h.ts - target);
      if (d < bestDist) { bestDist = d; prior = h; }
    }
    if (prior && bestDist > LOOKBACK_TOLERANCE_MS) prior = null;

    let priceDeltaPct: number | null = null;
    let oiDeltaPct: number | null = null;
    if (prior && prior.mark > 0) {
      // Both sides in display units (see above); the OI pair both in USD.
      priceDeltaPct = ((mark - prior.mark) / prior.mark) * 100;
      const priorOiUsd = (prior.oi ?? 0) * rawPriceOf(base, prior.mark);
      if (priorOiUsd > 0) oiDeltaPct = ((oiUsd - priorOiUsd) / priorOiUsd) * 100;
    }

    const fundingHourly = Number.isFinite(parseFloat(ctx.funding || ""))
      ? parseFloat(ctx.funding!)
      : null;

    items.push({
      base,
      price: mark,
      priceDeltaPct,
      oiUsd,
      oiDeltaPct,
      fundingHourly,
      regime: classifyRegime(oiDeltaPct, priceDeltaPct),
      spark: {
        px: downsample(hist.map((h) => h.mark), SPARK_POINTS),
        oi: downsample(hist.map((h) => (h.oi ?? 0) * rawPriceOf(base, h.mark)), SPARK_POINTS),
      },
      volume24h: vol,
      dex,
      sector,
    });
  }
  return items;
}

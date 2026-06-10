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

import { getMetaAndCtxs } from "./hyperliquid";
import { snapshotSeriesBulk } from "./db";
import { classifyRegime } from "./coinalyzePoller";

const TOP_N = 30;
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
  const { meta, assetCtxs } = await getMetaAndCtxs();
  const now = Date.now();

  // Top-N perps by 24h notional volume — where the leveraged flow is.
  const universe = meta.universe
    .map((u, i) => ({
      base: u.name,
      ctx: assetCtxs[i],
      vol: parseFloat(assetCtxs[i]?.dayNtlVlm || "0"),
    }))
    .filter((r) => r.ctx && r.vol > 0)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, TOP_N);

  const series = snapshotSeriesBulk(
    universe.map((r) => r.base),
    now - SPARK_WINDOW_MS
  );

  const items: HlDerivsItem[] = [];
  for (const { base, ctx, vol } of universe) {
    const mark = parseFloat(ctx.markPx || "0");
    const oiCoins = parseFloat(ctx.openInterest || "0");
    if (!Number.isFinite(mark) || mark <= 0) continue;
    const oiUsd = oiCoins * mark;

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
      priceDeltaPct = ((mark - prior.mark) / prior.mark) * 100;
      const priorOiUsd = (prior.oi ?? 0) * prior.mark;
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
        oi: downsample(hist.map((h) => (h.oi ?? 0) * h.mark), SPARK_POINTS),
      },
      volume24h: vol,
    });
  }
  return items;
}

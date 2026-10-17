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
import { marketContract, type MarketContract } from "./marketContract";
import {
  derivePositioningObservation,
  type PositioningObservation,
  type PositioningStatus,
} from "./positioningMetrics";
import { BUILDER_DEXES, HL_PERP_SECTOR_MAP, HL_BUILDER_PERP_MAP } from "@/config/sectors";
import { loadObservedSource } from "./sourceObservation";

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
export const DERIVS_SOURCE_MAX_AGE_MS = 2 * 60_000;
const DERIVS_MAX_SOURCE_FALLBACK_MS = 10 * 60_000;

type SourceResult<T> = {
  data: T;
  observedAt: number | null;
  failed: boolean;
  stale: boolean;
};

async function loadNativeSource(): Promise<SourceResult<Awaited<ReturnType<typeof getMetaAndCtxs>>>> {
  return loadObservedSource("hl:metaAndCtxs", getMetaAndCtxs, DERIVS_MAX_SOURCE_FALLBACK_MS);
}

async function loadBuilderSource(dex: string): Promise<SourceResult<Awaited<ReturnType<typeof getBuilderDexData>> | null>> {
  const key = `hl:builderDex:${dex}`;
  try {
    return await loadObservedSource(key, () => getBuilderDexData(dex), DERIVS_MAX_SOURCE_FALLBACK_MS);
  } catch {
    return { data: null, observedAt: null, failed: true, stale: false };
  }
}

export function oldestIncludedObservationAt(observedAt: Array<number | null>): number | null {
  if (observedAt.length === 0 || observedAt.some((value) => value == null || !Number.isFinite(value))) return null;
  return Math.min(...observedAt as number[]);
}

export interface HlDerivsItem {
  base: string;
  contract: MarketContract;
  price: number;
  priceDeltaPct: number | null;  // vs 15m ago
  oiUsd: number;                  // legacy cross-asset USD OI
  oiDeltaPct: number | null;      // legacy USD OI delta vs 15m
  oiCoins: number;                // canonical contract quantity
  oiCoinsChangePct: number | null;
  oiQuantityDeltaUsd: number | null; // quantity effect, valued at prior raw mark
  fundingHourly: number | null;   // live HL hourly funding rate (decimal)
  regime: string;                 // legacy classifier, retained for old clients
  quadrant: PositioningObservation["quadrant"];
  observationStatus: PositioningStatus;
  observationAt: number | null;
  priorObservationAt: number | null;
  observationAgeMs: number | null;
  observationSource: "price_snapshots";
  spark: { px: number[]; oi: number[]; oiCoins: number[] };
  volume24h: number;
  dex: string | null;             // builder dex that lists it; null = native HL
  sector: string | null;
}

export interface HlDerivsResponseMetadata {
  generatedAt: number;
  sourceObservedAt: number | null;
  sourceAgeMs: number | null;
  ageMs: number;
  status: "fresh" | "stale";
  stale: boolean;
  partial: boolean;
  failedSources: string[];
  staleSources: string[];
  error?: string;
}

export interface HlDerivsComputation {
  items: HlDerivsItem[];
  sourceObservedAt: number | null;
  failedSources: string[];
  staleSources: string[];
  partial: boolean;
}

export interface HlDerivsResponse {
  items: HlDerivsItem[];
  metadata: HlDerivsResponseMetadata;
}

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const step = values.length / maxPoints;
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(values[Math.floor(i * step)]);
  out[out.length - 1] = values[values.length - 1]; // always end on the latest
  return out;
}

export async function computeHlDerivsWithMetadata(): Promise<HlDerivsComputation> {
  const native = await loadNativeSource();
  const builders = await Promise.all(BUILDER_DEXES.map((dex) => loadBuilderSource(dex)));
  const failedSources = new Set<string>();
  const staleSources = new Set<string>();
  if (native.failed) failedSources.add("hyperliquid");
  if (native.stale) staleSources.add("hyperliquid");
  builders.forEach((source, index) => {
    const name = `builder:${BUILDER_DEXES[index]}`;
    if (source.failed) failedSources.add(name);
    if (source.stale) staleSources.add(name);
  });
  const [{ meta, assetCtxs }, ...builderResults] = [native.data, ...builders.map((source) => source.data)];
  const sourceObservedAtByDex = [native.observedAt, ...builders.map((source) => source.observedAt)];
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
    observedAt: number | null;
  };
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < meta.universe.length; i++) {
    const base = meta.universe[i].name;
    const ctx = assetCtxs[i];
    const vol = parseFloat(ctx?.dayNtlVlm || "0");
    // A native perp claims its ticker OUTRIGHT, even when quiet (zero
    // volume) — matching /api/markets, which keeps natives on price alone.
    // Claiming only on vol > 0 let a builder dex take the ticker of a
    // quiet native listing, and its deltas would then be computed against
    // snapshot history recorded from the NATIVE contract.
    seen.add(base);
    if (!ctx || !(vol > 0)) continue;
    candidates.push({ base, ctx, vol, dex: null, sector: HL_PERP_SECTOR_MAP[base]?.sector ?? null, observedAt: native.observedAt });
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
        observedAt: sourceObservedAtByDex[d + 1],
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
  for (const { base, ctx, vol, dex, sector, observedAt } of universe) {
    // Work in DISPLAY units throughout: price_snapshots stores the scaled
    // mark, so a raw markPx here would compare 0.37 against 7407 for SPX
    // and report a -99.99% move. USD OI divides the scale back out (see
    // rawPriceOf) since openInterest is coin-denominated.
    const rawMark = parseFloat(ctx.markPx || "0");
    const mark = rawMark * displayScaleOf(base);
    const oiCoins = parseFloat(ctx.openInterest || "0");
    if (!Number.isFinite(mark) || mark <= 0 || !Number.isFinite(oiCoins) || oiCoins < 0) continue;
    const displayScale = displayScaleOf(base);
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

    const observation = derivePositioningObservation({
      symbol: base,
      horizonMs: LOOKBACK_MS,
      toleranceMs: LOOKBACK_TOLERANCE_MS,
      displayScale,
      current: { ts: observedAt ?? Number.NaN, mark, oiCoins },
      prior: prior
        ? { ts: prior.ts, mark: prior.mark, oiCoins: prior.oi }
        : null,
      now,
      currentMaxAgeMs: DERIVS_SOURCE_MAX_AGE_MS,
    });
    let oiDeltaPct: number | null = null;
    if (prior && prior.mark > 0 && prior.oi != null && prior.oi > 0) {
      const priorOiUsd = prior.oi * rawPriceOf(base, prior.mark);
      if (priorOiUsd > 0) oiDeltaPct = ((oiUsd - priorOiUsd) / priorOiUsd) * 100;
    }
    const contract = marketContract(base, dex);

    const fundingHourly = Number.isFinite(parseFloat(ctx.funding || ""))
      ? parseFloat(ctx.funding!)
      : null;

    items.push({
      base,
      contract,
      price: mark,
      priceDeltaPct: observation.priceChangePct,
      oiUsd,
      oiDeltaPct,
      oiCoins,
      oiCoinsChangePct: observation.oiCoinsChangePct,
      oiQuantityDeltaUsd: observation.oiQuantityDeltaUsd,
      fundingHourly,
      regime: classifyRegime(oiDeltaPct, observation.priceChangePct),
      quadrant: observation.quadrant,
      observationStatus: observation.status,
      observationAt: observedAt,
      priorObservationAt: observation.priorTs,
      observationAgeMs: observation.currentAgeMs,
      observationSource: "price_snapshots",
      spark: {
        px: downsample(hist.map((h) => h.mark), SPARK_POINTS),
        oi: downsample(hist.map((h) => (h.oi ?? 0) * rawPriceOf(base, h.mark)), SPARK_POINTS),
        oiCoins: downsample(hist.map((h) => h.oi ?? 0), SPARK_POINTS),
      },
      volume24h: vol,
      dex,
      sector,
    });
  }
  const sourceObservedAt = oldestIncludedObservationAt(items.map((item) => item.observationAt));
  return {
    items,
    sourceObservedAt,
    failedSources: [...failedSources],
    staleSources: [...staleSources],
    partial: failedSources.size > 0 || staleSources.size > 0 || sourceObservedAt == null,
  };
}

export async function computeHlDerivs(): Promise<HlDerivsItem[]> {
  return (await computeHlDerivsWithMetadata()).items;
}

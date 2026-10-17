import { BUILDER_DEXES } from "@/config/sectors";
import {
  getBuilderDexData,
  getMetaAndCtxs,
} from "./hyperliquid";
import { displayScaleOf } from "./priceScale";
import {
  getCandlesBulkFromCache,
  snapshotFullAtBounded,
  type CandleRow,
  type SnapshotPointFull,
} from "./db";
import { cache } from "./cache";
import { marketContract } from "./marketContract";
import {
  buildRotationMetric,
  estimateCandleVolume,
  rotationWindowMs,
  ROTATION_WINDOWS,
  ROTATION_MAX_STALE_MS,
  type RotationMarketContract,
  type RotationPayload,
  type RotationRow,
  type RotationSnapshotPoint,
  type RotationWindow,
} from "./rotation";

export const ROTATION_CACHE_KEY = "api:rotation";
export const ROTATION_TTL_MS = 30_000;
export const ROTATION_CURRENT_MAX_AGE_MS = 2 * 60_000;
export const ROTATION_HISTORICAL_TOLERANCE_MS = 10 * 60_000;
export const ROTATION_CANDLE_INTERVAL_MS = 3_600_000;
export const ROTATION_CANDLE_COUNT = 7 * 24 + 2;

type SourceAsset = {
  symbol: string;
  name: string;
  contract: RotationMarketContract;
  current: RotationSnapshotPoint;
  volume24h: number;
};

export interface RotationBuildDeps {
  now: number;
  assets: SourceAsset[];
  historicalSnapshot: (targetTs: number, toleranceMs: number, symbols: string[]) => Map<string, SnapshotPointFull>;
  candles: (symbols: string[], interval: string, count: number) => Map<string, CandleRow[]>;
  currentSourceAgeMs?: number;
  cacheAgeMs?: number;
  stale?: boolean;
  partialSources?: string[];
}

function numberOrNull(value: unknown, minimum = -Infinity): number | null {
  if (typeof value === "boolean" || value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : null;
}

export function rotationPointFromContext(
  ctx: { markPx?: string; openInterest?: string; funding?: string },
  ts: number,
  scale: number,
): RotationSnapshotPoint | null {
  const rawMark = numberOrNull(ctx.markPx, 0);
  if (rawMark == null || rawMark <= 0) return null;
  const mark = rawMark * scale;
  if (!Number.isFinite(mark) || mark <= 0) return null;
  const oi = numberOrNull(ctx.openInterest, 0);
  const funding = numberOrNull(ctx.funding);
  return { ts, mark, oi, funding };
}

function pointFromHistory(row: SnapshotPointFull | undefined): RotationSnapshotPoint | null {
  if (!row || !Number.isFinite(row.ts) || !Number.isFinite(row.mark) || row.mark <= 0) return null;
  return {
    ts: row.ts,
    mark: row.mark,
    oi: row.oi == null ? null : numberOrNull(row.oi, 0),
    funding: row.funding == null ? null : numberOrNull(row.funding),
  };
}

function sourceAsset(
  symbol: string,
  name: string,
  contract: RotationMarketContract,
  ctx: { markPx?: string; openInterest?: string; funding?: string; dayNtlVlm?: string },
  now: number,
): SourceAsset | null {
  const scale = displayScaleOf(symbol);
  const current = rotationPointFromContext(ctx, now, scale);
  if (!current) return null;
  return {
    symbol,
    name,
    contract,
    current,
    volume24h: numberOrNull(ctx.dayNtlVlm, 0) ?? 0,
  };
}

function completedCandleVolume(
  candles: CandleRow[] | undefined,
  now: number,
  window: RotationWindow,
) {
  // `now` is intentionally rounded down. This reports the completed source
  // window instead of pretending a partial current hour is exact endpoint data.
  const completedEnd = Math.floor(now / ROTATION_CANDLE_INTERVAL_MS) * ROTATION_CANDLE_INTERVAL_MS;
  const from = completedEnd - rotationWindowMs(window);
  if (!candles) return estimateCandleVolume([], from, completedEnd);
  return estimateCandleVolume(
    candles.map((candle) => ({
      t: candle.t,
      open: candle.o,
      close: candle.c,
      // candles_cache stores Hyperliquid's RAW candle quote and base volume.
      volumeBase: candle.v,
    })),
    from,
    completedEnd,
  );
}

export function buildRotationPayload(deps: RotationBuildDeps): RotationPayload {
  const historyKeys = deps.assets.map((asset) => asset.contract.historyKey);
  const historyByWindow = new Map<RotationWindow, Map<string, SnapshotPointFull>>();
  for (const window of ROTATION_WINDOWS) {
    const points = new Map<string, SnapshotPointFull>();
    // Source caches are observed independently. Group equal source timestamps
    // so every historical target is derived from its own paired current point,
    // without a whole-table correlated query.
    const byCurrentTs = new Map<number, string[]>();
    for (const asset of deps.assets) {
      const symbols = byCurrentTs.get(asset.current.ts) ?? [];
      symbols.push(asset.contract.historyKey);
      byCurrentTs.set(asset.current.ts, symbols);
    }
    for (const [currentTs, symbols] of byCurrentTs) {
      const historical = deps.historicalSnapshot(
        currentTs - rotationWindowMs(window),
        ROTATION_HISTORICAL_TOLERANCE_MS,
        symbols,
      );
      for (const [symbol, point] of historical) points.set(symbol, point);
    }
    historyByWindow.set(window, points);
  }
  const candlesBySymbol = (() => {
    try {
      return deps.candles(historyKeys, "1h", ROTATION_CANDLE_COUNT);
    } catch {
      return new Map<string, CandleRow[]>();
    }
  })();
  const rows: RotationRow[] = deps.assets.map((asset) => {
    const windows = Object.fromEntries(ROTATION_WINDOWS.map((window) => {
      const historical = historyByWindow.get(window)?.get(asset.contract.historyKey);
      const prior = pointFromHistory(historical);
      return [window, buildRotationMetric(
        window,
        asset.current,
        prior,
        asset.symbol,
        displayScaleOf(asset.symbol),
        completedCandleVolume(candlesBySymbol.get(asset.contract.historyKey), asset.current.ts, window),
      )];
    })) as Record<RotationWindow, ReturnType<typeof buildRotationMetric>>;
    return {
      symbol: asset.symbol,
      name: asset.name,
      contract: asset.contract,
      current: asset.current,
      volume24h: asset.volume24h,
      windows,
    };
  });
  return {
    generatedAt: deps.now,
    metadata: {
      source: "hyperliquid",
      snapshotStore: "price_snapshots",
      historyIdentity: "legacy-symbol",
      currentMaxAgeMs: ROTATION_CURRENT_MAX_AGE_MS,
      currentSourceAgeMs: deps.currentSourceAgeMs ?? 0,
      historicalToleranceMs: ROTATION_HISTORICAL_TOLERANCE_MS,
      candleInterval: "1h",
      stale: deps.stale ?? false,
      cacheAgeMs: deps.cacheAgeMs ?? 0,
      warming: rows.length === 0,
      partialSources: deps.partialSources ?? [],
    },
    rows,
  };
}

async function collectSourceAssets(): Promise<{
  assets: SourceAsset[];
  currentSourceAgeMs: number;
  partialSources: string[];
  observedAt: number;
}> {
  const [, ...builderResults] = await Promise.all([
    getMetaAndCtxs(),
    ...BUILDER_DEXES.map((dex) => getBuilderDexData(dex).catch(() => null)),
  ]);
  const observedAt = Date.now();
  const nativeInfo = cache.getInfo<{ meta: { universe: Array<{ name: string }> }; assetCtxs: Array<{ markPx?: string; openInterest?: string; funding?: string; dayNtlVlm?: string }> }>("hl:metaAndCtxs");
  if (!nativeInfo) throw new Error("Hyperliquid native metadata has no observed cache timestamp");
  if (nativeInfo.createdAt > observedAt) throw new Error("Hyperliquid native metadata has a future cache timestamp");
  // Read the object that owns the timestamp. A stale-while-revalidate call
  // may have returned an older object while its refresh replaced the cache
  // before this continuation resumed.
  const nativeData = nativeInfo.data;
  const nativeAgeMs = observedAt - nativeInfo.createdAt;
  if (nativeAgeMs > ROTATION_CURRENT_MAX_AGE_MS) {
    throw new Error(`Hyperliquid native metadata is ${Math.round(nativeAgeMs / 1000)}s old`);
  }
  const assets: SourceAsset[] = [];
  const partialSources: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < nativeData.meta.universe.length; i += 1) {
    const universe = nativeData.meta.universe[i];
    const ctx = nativeData.assetCtxs[i];
    const symbol = universe.name;
    if (seen.has(symbol)) continue;
    // Claim native ownership before validating the listing. A malformed or
    // quiet native row must not fall through to builder history for the same
    // legacy symbol.
    seen.add(symbol);
    const contract: RotationMarketContract = marketContract(symbol);
    const asset = sourceAsset(symbol, symbol, contract, ctx ?? {}, nativeInfo.createdAt);
    if (asset) {
      assets.push(asset);
    }
  }

  // Native markets claim a bare ticker first. Among HIP-3 markets, configured
  // BUILDER_DEXES order is the deterministic precedence order.
  let blockedByMissingSource = false;
  for (let dexIndex = 0; dexIndex < BUILDER_DEXES.length; dexIndex += 1) {
    const dex = BUILDER_DEXES[dexIndex];
    const result = builderResults[dexIndex];
    const info = cache.getInfo<{ meta: { universe: Array<{ name: string }> }; assetCtxs: Array<{ markPx?: string; openInterest?: string; funding?: string; dayNtlVlm?: string }> }>(`hl:builderDex:${dex}`);
    if (blockedByMissingSource || !result || !info) {
      partialSources.push(dex);
      blockedByMissingSource = true;
      continue;
    }
    if (info.createdAt > observedAt) {
      partialSources.push(dex);
      blockedByMissingSource = true;
      continue;
    }
    const ageMs = observedAt - info.createdAt;
    if (ageMs > ROTATION_CURRENT_MAX_AGE_MS) {
      partialSources.push(dex);
      blockedByMissingSource = true;
      continue;
    }
    const builderData = info.data;
    for (let i = 0; i < builderData.meta.universe.length; i += 1) {
      const raw = builderData.meta.universe[i].name;
      const symbol = raw.includes(":") ? raw.split(":").slice(1).join(":") : raw;
      if (seen.has(symbol)) continue;
      const ctx = builderData.assetCtxs[i];
      // Match the snapshot writer: the first LIVE builder owns the ticker.
      // Native names are claimed unconditionally, but ghost builders are not.
      if (!ctx || !((numberOrNull(ctx.dayNtlVlm, 0) ?? 0) > 0)) continue;
      // The writer excludes zero/missing marks before claiming ownership,
      // but may reserve malformed nonzero marks. Do not let those splice a
      // later venue onto legacy history; reserve then fail closed below.
      if (parseFloat(ctx.markPx || "0") === 0) continue;
      seen.add(symbol);
      const contract: RotationMarketContract = marketContract(symbol, dex);
      const asset = sourceAsset(symbol, symbol, contract, ctx, info.createdAt);
      if (asset) {
        assets.push(asset);
      }
    }
  }
  const currentSourceAgeMs = Math.max(
    nativeAgeMs,
    ...BUILDER_DEXES.map((dex, index) => {
      if (partialSources.includes(dex) || !builderResults[index]) return 0;
      const info = cache.getInfo(`hl:builderDex:${dex}`);
      return info ? Math.max(0, observedAt - info.createdAt) : 0;
    }),
  );
  return { assets, currentSourceAgeMs, partialSources, observedAt };
}

export async function getRotationSnapshot(): Promise<RotationPayload> {
  const data = await cache.getWithRefresh(
    ROTATION_CACHE_KEY,
    async () => {
      const source = await collectSourceAssets();
      // Do not label a response with the time at which its network work
      // started. Source/cache timestamps are already attached to the points;
      // this is the response generation boundary after all awaits.
      const generatedAt = Date.now();
      return buildRotationPayload({
        now: generatedAt,
        assets: source.assets,
        historicalSnapshot: snapshotFullAtBounded,
        candles: getCandlesBulkFromCache,
        stale: false,
        cacheAgeMs: 0,
        currentSourceAgeMs: source.currentSourceAgeMs + Math.max(0, generatedAt - source.observedAt),
        partialSources: source.partialSources,
      });
    },
    ROTATION_TTL_MS,
    ROTATION_MAX_STALE_MS,
  );
  const info = cache.getInfo<RotationPayload>(ROTATION_CACHE_KEY);
  const current = info?.data ?? data;
  const now = Date.now();
  if (current.generatedAt > now) throw new Error("Rotation payload has a future generation timestamp");
  const elapsed = now - current.generatedAt;
  const currentSourceAgeMs = current.metadata.currentSourceAgeMs + elapsed;
  return {
    ...current,
    metadata: {
      ...current.metadata,
      currentSourceAgeMs,
      stale: Boolean(current.metadata.stale || currentSourceAgeMs > current.metadata.currentMaxAgeMs
        || (info && !info.fresh)),
      cacheAgeMs: info?.ageMs ?? Math.max(0, elapsed),
    },
  };
}

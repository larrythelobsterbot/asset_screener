import type { AssetMarketIdentity } from "./assetMarketIdentity";
import type { HLAssetCtx, HLCandle, HLMeta } from "./hyperliquid";

export type FundingHistoryRow = {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
};

type MetaAndContexts = {
  meta: HLMeta;
  assetCtxs: HLAssetCtx[];
};

export type AssetDetailMarketDependencies = {
  getCandles: (
    coin: string,
    interval: string,
    count: number,
    cacheSymbol: string,
  ) => Promise<HLCandle[]>;
  getFundingHistory: (coin: string) => Promise<FundingHistoryRow[]>;
  getMetaAndCtxs: () => Promise<MetaAndContexts>;
  getAllMids: () => Promise<Record<string, string>>;
  getBuilderDexData: (dex: string) => Promise<MetaAndContexts>;
};

export type AssetDetailMarketData = {
  candles: HLCandle[];
  funding: FundingHistoryRow[];
  hlData: MetaAndContexts;
  allMids: Record<string, string>;
  builderData: MetaAndContexts | null;
};

export type AssetDetailMarketOptions = {
  /** Preloaded metadata is supplied by the route after identity validation. */
  hlData?: MetaAndContexts;
  builderData?: MetaAndContexts | null;
  /** Qualified selections must not reuse legacy bare-ticker candle rows. */
  candleCacheSymbol?: string;
};

/** Verify the requested contract is present in the selected live venue. */
export function assetMarketExistsInLiveUniverse(
  market: AssetMarketIdentity,
  data: MetaAndContexts,
  options: { allowBareBuilderName?: boolean; builderDex?: string } = {},
): boolean {
  if (market.kind === "spot") return true;
  return data.meta.universe.some((entry) => {
    if (market.kind === "native-perp") return entry.name === market.symbol;
    if (entry.name === market.wireCoin) return true;
    // Some live builder responses use a bare ticker even though the request
    // was scoped to one DEX. A qualified row must still match exactly; a
    // qualified row from another venue can never satisfy this check.
    return (options.allowBareBuilderName !== false || options.builderDex != null)
      && !entry.name.includes(":")
      && entry.name === market.symbol;
  });
}

/**
 * Fetch the market-dependent inputs for the asset-detail route from one
 * resolved identity. Individual candle/funding/builder failures preserve the
 * route's existing partial-response behavior; native metadata and all-mids
 * remain required because those failures have always failed the whole route.
 */
export async function fetchAssetDetailMarketData(
  market: AssetMarketIdentity,
  deps: AssetDetailMarketDependencies,
  options: AssetDetailMarketOptions = {},
): Promise<AssetDetailMarketData> {
  const builderDataPromise = market.kind === "builder-perp"
    ? options.builderData !== undefined
      ? Promise.resolve(options.builderData)
      : deps.getBuilderDexData(market.builderDex).catch(() => null)
    : Promise.resolve(null);
  const fundingPromise: Promise<FundingHistoryRow[]> = market.kind === "spot"
    ? Promise.resolve([])
    : deps.getFundingHistory(market.wireCoin).catch(() => []);

  const [candles, funding, hlData, allMids, builderData] = await Promise.all([
    deps.getCandles(
      market.wireCoin,
      "4h",
      350,
      options.candleCacheSymbol ?? market.cacheSymbol,
    ).catch(() => []),
    fundingPromise,
    options.hlData ? Promise.resolve(options.hlData) : deps.getMetaAndCtxs(),
    deps.getAllMids(),
    builderDataPromise,
  ]);

  return { candles, funding, hlData, allMids, builderData };
}

/** Select the current perp context from the same venue as the wire identity. */
export function selectAssetPerpContext(
  market: AssetMarketIdentity,
  data: AssetDetailMarketData,
): HLAssetCtx | null {
  if (market.kind === "spot") return null;

  const perpData = market.kind === "builder-perp" ? data.builderData : data.hlData;
  const idx = perpData?.meta.universe.findIndex((entry) => {
    if (market.kind !== "builder-perp") return entry.name === market.symbol;
    const ticker = entry.name.includes(":") ? entry.name.split(":").at(-1) : entry.name;
    return entry.name === market.wireCoin || ticker === market.symbol;
  }) ?? -1;

  return idx >= 0 ? perpData?.assetCtxs[idx] ?? null : null;
}

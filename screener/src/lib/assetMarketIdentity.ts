import {
  BUILDER_DEXES,
  HL_BUILDER_PERP_MAP,
  HL_PERP_SECTOR_MAP,
  HL_SPOT_STOCKS,
} from "../config/sectors";

type BaseAssetMarketIdentity = {
  symbol: string;
  wireCoin: string;
  cacheSymbol: string;
};

export type AssetMarketIdentity =
  | (BaseAssetMarketIdentity & { kind: "spot"; builderDex: null })
  | (BaseAssetMarketIdentity & { kind: "native-perp"; builderDex: null })
  | (BaseAssetMarketIdentity & { kind: "builder-perp"; builderDex: string });

const ROUTE_SYMBOL_PATTERN = /^[A-Za-z0-9._-]{1,24}$/;

const SPOT_NAME_BY_TICKER = new Map<string, string>();
for (const [spotName, info] of Object.entries(HL_SPOT_STOCKS)) {
  SPOT_NAME_BY_TICKER.set(info.ticker, spotName);
}

/**
 * Resolve the bare symbol accepted by /api/asset/[symbol] to the exact
 * Hyperliquid wire identity used by every upstream request for that asset.
 *
 * Precedence intentionally matches the existing detail route and markets
 * table: tracked spot stocks first, native perps second, then the first
 * configured builder DEX. Builder candles keep their local cache under the
 * bare ticker while funding and metadata use the DEX-qualified coin.
 */
export function resolveAssetMarketIdentity(symbol: string): AssetMarketIdentity | null {
  if (!ROUTE_SYMBOL_PATTERN.test(symbol)) return null;

  const spotName = SPOT_NAME_BY_TICKER.get(symbol);
  if (spotName) {
    return {
      kind: "spot",
      symbol,
      wireCoin: spotName,
      cacheSymbol: spotName,
      builderDex: null,
    };
  }

  if (HL_PERP_SECTOR_MAP[symbol]) {
    return {
      kind: "native-perp",
      symbol,
      wireCoin: symbol,
      cacheSymbol: symbol,
      builderDex: null,
    };
  }

  for (const dex of BUILDER_DEXES) {
    const wireCoin = `${dex}:${symbol}`;
    if (!HL_BUILDER_PERP_MAP[wireCoin]) continue;
    return {
      kind: "builder-perp",
      symbol,
      wireCoin,
      cacheSymbol: symbol,
      builderDex: dex,
    };
  }

  return null;
}

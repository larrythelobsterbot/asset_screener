// Pure display/raw price conversion shared by server and client bundles.
// Keep the map here so importing rotation metrics never drags in Hyperliquid,
// SQLite, or Node-only modules through the server data layer.
export const PRICE_DISPLAY_SCALE: Record<string, number> = { SPX: 20_000 };

export function displayScaleOf(symbol: string): number {
  return PRICE_DISPLAY_SCALE[symbol] ?? 1;
}

/** Convert a display-unit price to Hyperliquid's raw quote units. */
export function rawPriceOf(symbol: string, displayPrice: number): number {
  return displayPrice / displayScaleOf(symbol);
}

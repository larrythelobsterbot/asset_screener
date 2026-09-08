/** Canonical identity for a selected Hyperliquid perp contract. */
export interface MarketContract {
  kind: "native" | "hip3";
  dex: string | null;
  wireCoin: string;
  /** Existing snapshot/candle key. Historical rows do not carry venue identity. */
  historyKey: string;
}

/**
 * Resolve a displayed bare ticker to the exact selected wire contract.
 * `historyKey` deliberately remains bare: legacy snapshots predate venue
 * identity and must never be presented as venue-qualified history.
 */
export function marketContract(symbol: string, dex?: string | null): MarketContract {
  const selectedDex = dex == null || dex === "" ? null : dex;
  return {
    kind: selectedDex == null ? "native" : "hip3",
    dex: selectedDex,
    wireCoin: selectedDex == null ? symbol : `${selectedDex}:${symbol}`,
    historyKey: symbol,
  };
}

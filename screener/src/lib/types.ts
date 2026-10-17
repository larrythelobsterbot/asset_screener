import { Sector } from "@/config/sectors";
import type { MarketContract } from "@/lib/marketContract";

export interface AssetData {
  symbol: string;
  name: string;
  sector: Sector;
  sectorColor: string;
  price: number;
  change1h: number | null;
  change4h: number | null;
  change24h: number | null;
  change7d: number | null;
  volume24h: number;
  fundingRate: number | null;
  openInterest: number | null;
  markPrice: number | null;
  oraclePrice: number | null;
  source: "hyperliquid" | "coingecko";
  /** Selected current perp identity; historical rows remain keyed by symbol. */
  contract?: MarketContract | null;

  // ── Flow metrics ──────────────────────────────────────────────────────
  // Derived from price_snapshots history, HL-sourced assets only; null on
  // CoinGecko rows and during cold start. Price change says what happened
  // to existing holders; OI change says where new money went.
  //
  // NOTE: `openInterest` above is denominated in COINS (HL's native unit).
  // `oiUsd` is that multiplied by price — use it for any cross-asset
  // comparison, since coin-denominated OI is meaningless between assets.
  oiUsd: number | null;
  /** Hyperliquid's canonical contract quantity, in coins. */
  oiCoins?: number | null;
  oiChange24hUsd: number | null;
  oiChange24hPct: number | null;
  oiCoinsChange24hPct?: number | null;
  oiQuantityDelta24hUsd?: number | null;
  oiChange7dUsd: number | null;
  oiChange7dPct: number | null;
  oiCoinsChange7dPct?: number | null;
  oiQuantityDelta7dUsd?: number | null;
  positioning24h?: PositioningMetadata | null;
  positioning7d?: PositioningMetadata | null;
  // Mean hourly funding rate over 24h (decimal, ×24×365×100 for APR%).
  // The instantaneous `fundingRate` whipsaws on thin HIP-3 markets; this
  // is what separates structural crowding from noise.
  fundingAvg24h: number | null;
  // volume24h / oiUsd. High = hot money churning, low = parked positions.
  volOiRatio: number | null;
}

export interface PositioningMetadata {
  status: "observed" | "unavailable" | "stale";
  currentTs: number | null;
  priorTs: number | null;
  historicalAgeMs: number | null;
  source: "price_snapshots";
}

export interface MacroData {
  symbol: string;
  label: string;
  value: number | null;
  change: number | null;
  source: "live" | "delayed" | "static";
  asOf: number | null;
  stale?: boolean;
}

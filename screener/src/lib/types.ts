import { Sector } from "@/config/sectors";

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
}

export interface MacroData {
  symbol: string;
  label: string;
  value: number | null;
  change: number | null;
  source: "live" | "delayed" | "static";
}

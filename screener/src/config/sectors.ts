export type Sector =
  | "l1"
  | "defi"
  | "meme"
  | "ai"
  | "gaming"
  | "infra"
  | "stocks"
  | "commodities"
  | "preipo"
  | "indices"
  | "crypto-major"
  | "crypto-alt";

export interface SectorConfig {
  id: Sector;
  label: string;
  color: string;
}

export const SECTORS: Record<Sector, SectorConfig> = {
  stocks: { id: "stocks", label: "Stocks", color: "#3B82F6" },
  indices: { id: "indices", label: "Indices", color: "#FCD34D" },
  commodities: { id: "commodities", label: "Commodities", color: "#F59E0B" },
  preipo: { id: "preipo", label: "Pre-IPO", color: "#8B5CF6" },
  l1: { id: "l1", label: "Layer 1s", color: "#3B82F6" },
  defi: { id: "defi", label: "DeFi", color: "#10B981" },
  meme: { id: "meme", label: "Memecoins", color: "#EC4899" },
  ai: { id: "ai", label: "AI & Data", color: "#A78BFA" },
  gaming: { id: "gaming", label: "Gaming", color: "#F97316" },
  infra: { id: "infra", label: "Infrastructure", color: "#64748B" },
  "crypto-major": { id: "crypto-major", label: "Crypto Majors", color: "#06B6D4" },
  "crypto-alt": { id: "crypto-alt", label: "Crypto Alts", color: "#F43F5E" },
};

// Hyperliquid PERP ticker → sector mapping
export const HL_PERP_SECTOR_MAP: Record<string, { sector: Sector; label: string }> = {
  // Layer 1s
  BTC: { sector: "l1", label: "Bitcoin" },
  ETH: { sector: "l1", label: "Ethereum" },
  SOL: { sector: "l1", label: "Solana" },
  AVAX: { sector: "l1", label: "Avalanche" },
  SUI: { sector: "l1", label: "Sui" },
  APT: { sector: "l1", label: "Aptos" },
  SEI: { sector: "l1", label: "Sei" },
  NEAR: { sector: "l1", label: "NEAR" },
  DOT: { sector: "l1", label: "Polkadot" },
  ATOM: { sector: "l1", label: "Cosmos" },
  ICP: { sector: "l1", label: "ICP" },
  TIA: { sector: "l1", label: "Celestia" },
  INJ: { sector: "l1", label: "Injective" },
  HYPE: { sector: "l1", label: "Hyperliquid" },
  BERA: { sector: "l1", label: "Berachain" },
  ADA: { sector: "l1", label: "Cardano" },
  TON: { sector: "l1", label: "Toncoin" },
  XRP: { sector: "l1", label: "Ripple" },
  BNB: { sector: "l1", label: "BNB" },
  // DeFi
  AAVE: { sector: "defi", label: "Aave" },
  UNI: { sector: "defi", label: "Uniswap" },
  MKR: { sector: "defi", label: "Maker" },
  DYDX: { sector: "defi", label: "dYdX" },
  PENDLE: { sector: "defi", label: "Pendle" },
  CRV: { sector: "defi", label: "Curve" },
  JUP: { sector: "defi", label: "Jupiter" },
  ONDO: { sector: "defi", label: "Ondo" },
  ENA: { sector: "defi", label: "Ethena" },
  LDO: { sector: "defi", label: "Lido" },
  SNX: { sector: "defi", label: "Synthetix" },
  // Memecoins
  DOGE: { sector: "meme", label: "Dogecoin" },
  kPEPE: { sector: "meme", label: "Pepe" },
  kSHIB: { sector: "meme", label: "Shiba Inu" },
  kBONK: { sector: "meme", label: "Bonk" },
  WIF: { sector: "meme", label: "dogwifhat" },
  PNUT: { sector: "meme", label: "Peanut" },
  POPCAT: { sector: "meme", label: "Popcat" },
  TRUMP: { sector: "meme", label: "TRUMP" },
  FARTCOIN: { sector: "meme", label: "Fartcoin" },
  BRETT: { sector: "meme", label: "Brett" },
  // AI & Data
  FET: { sector: "ai", label: "Fetch.ai" },
  RENDER: { sector: "ai", label: "Render" },
  TAO: { sector: "ai", label: "Bittensor" },
  AR: { sector: "ai", label: "Arweave" },
  VIRTUAL: { sector: "ai", label: "Virtuals" },
  AIXBT: { sector: "ai", label: "AIXBT" },
  GRASS: { sector: "ai", label: "Grass" },
  IO: { sector: "ai", label: "io.net" },
  // Gaming
  IMX: { sector: "gaming", label: "Immutable X" },
  GALA: { sector: "gaming", label: "Gala" },
  AXS: { sector: "gaming", label: "Axie" },
  PIXEL: { sector: "gaming", label: "Pixels" },
  SUPER: { sector: "gaming", label: "SuperVerse" },
  // Infrastructure
  LINK: { sector: "infra", label: "Chainlink" },
  FIL: { sector: "infra", label: "Filecoin" },
  OP: { sector: "infra", label: "Optimism" },
  ARB: { sector: "infra", label: "Arbitrum" },
  STX: { sector: "infra", label: "Stacks" },
  STRK: { sector: "infra", label: "Starknet" },
  PYTH: { sector: "infra", label: "Pyth" },
  ENS: { sector: "infra", label: "ENS" },
  ZK: { sector: "infra", label: "ZKsync" },
  W: { sector: "infra", label: "Wormhole" },
  // Indices (perp)
  SPX: { sector: "indices", label: "S&P 500" },
  // Commodities (perp)
  PAXG: { sector: "commodities", label: "Gold (PAXG)" },
};

// Hyperliquid HIP-3 SPOT stocks — @N identifier → info
// These are builder-deployed spot pairs under spotMeta
export const HL_SPOT_STOCKS: Record<string, { ticker: string; sector: Sector; label: string; tokenIndex: number }> = {
  "@264": { ticker: "TSLA", sector: "stocks", label: "Tesla", tokenIndex: 407 },
  "@265": { ticker: "NVDA", sector: "stocks", label: "NVIDIA", tokenIndex: 408 },
  "@268": { ticker: "AAPL", sector: "stocks", label: "Apple", tokenIndex: 413 },
  "@279": { ticker: "SPY", sector: "indices", label: "SPY ETF", tokenIndex: 420 },
  "@280": { ticker: "AMZN", sector: "stocks", label: "Amazon", tokenIndex: 421 },
  "@287": { ticker: "META", sector: "stocks", label: "Meta", tokenIndex: 422 },
  "@288": { ticker: "QQQ", sector: "indices", label: "QQQ ETF", tokenIndex: 426 },
  "@289": { ticker: "MSFT", sector: "stocks", label: "Microsoft", tokenIndex: 429 },
};

// CoinGecko IDs to fetch — only ones NOT covered by Hyperliquid perps
export const COINGECKO_IDS = [
  "tether", "binancecoin", "ripple", "usd-coin", "cardano",
  "tron", "stellar", "litecoin",
];

// Macro indicators for the top bar
export const MACRO_INDICATORS = [
  { symbol: "DXY", label: "US Dollar", source: "static" as const },
  { symbol: "VIX", label: "Volatility", source: "static" as const },
  { symbol: "US10Y", label: "US 10Y", source: "static" as const },
  { symbol: "SPX", label: "S&P 500", source: "live" as const },
  { symbol: "PAXG", label: "Gold", source: "live" as const },
];

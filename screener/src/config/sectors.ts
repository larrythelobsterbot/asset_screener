export type Sector =
  | "majors"
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
  | "forex"
  | "crypto-major"
  | "crypto-alt";

export interface SectorConfig {
  id: Sector;
  label: string;
  color: string;
}

export const SECTORS: Record<Sector, SectorConfig> = {
  majors: { id: "majors", label: "Majors", color: "#F0B90B" },
  stocks: { id: "stocks", label: "Stocks", color: "#3B82F6" },
  indices: { id: "indices", label: "Indices", color: "#FCD34D" },
  commodities: { id: "commodities", label: "Commodities", color: "#F59E0B" },
  forex: { id: "forex", label: "Forex", color: "#38BDF8" },
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
  // ── Majors ──────────────────────────────────────────────────────────────
  BTC: { sector: "majors", label: "Bitcoin" },
  ETH: { sector: "majors", label: "Ethereum" },
  SOL: { sector: "majors", label: "Solana" },
  BNB: { sector: "majors", label: "BNB" },
  XRP: { sector: "majors", label: "Ripple" },

  // ── Layer 1s ─────────────────────────────────────────────────────────────
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
  // Additional L1s
  ALGO: { sector: "l1", label: "Algorand" },
  BCH: { sector: "l1", label: "Bitcoin Cash" },
  BSV: { sector: "l1", label: "Bitcoin SV" },
  CANTO: { sector: "l1", label: "Canto" },
  CFX: { sector: "l1", label: "Conflux" },
  DASH: { sector: "l1", label: "Dash" },
  DYM: { sector: "l1", label: "Dymension" },
  ETC: { sector: "l1", label: "Ethereum Classic" },
  FTM: { sector: "l1", label: "Fantom" },
  HBAR: { sector: "l1", label: "Hedera" },
  IOTA: { sector: "l1", label: "IOTA" },
  KAS: { sector: "l1", label: "Kaspa" },
  LTC: { sector: "l1", label: "Litecoin" },
  MATIC: { sector: "l1", label: "Polygon" },
  MINA: { sector: "l1", label: "Mina" },
  MON: { sector: "l1", label: "Monad" },
  MOVE: { sector: "l1", label: "Movement" },
  NEO: { sector: "l1", label: "Neo" },
  NTRN: { sector: "l1", label: "Neutron" },
  OM: { sector: "l1", label: "MANTRA" },
  POL: { sector: "l1", label: "Polygon 2.0" },
  S: { sector: "l1", label: "Sonic" },
  TRX: { sector: "l1", label: "Tron" },
  XLM: { sector: "l1", label: "Stellar" },
  XMR: { sector: "l1", label: "Monero" },
  ZEC: { sector: "l1", label: "Zcash" },
  ZETA: { sector: "l1", label: "ZetaChain" },
  CELO: { sector: "l1", label: "Celo" },

  // ── DeFi ─────────────────────────────────────────────────────────────────
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
  // Additional DeFi
  AERO: { sector: "defi", label: "Aerodrome" },
  APEX: { sector: "defi", label: "ApeX Protocol" },
  BADGER: { sector: "defi", label: "Badger DAO" },
  BIO: { sector: "defi", label: "BIO Protocol" },
  BNT: { sector: "defi", label: "Bancor" },
  CAKE: { sector: "defi", label: "PancakeSwap" },
  COMP: { sector: "defi", label: "Compound" },
  EIGEN: { sector: "defi", label: "EigenLayer" },
  ETHFI: { sector: "defi", label: "Ether.fi" },
  FXS: { sector: "defi", label: "Frax" },
  GMX: { sector: "defi", label: "GMX" },
  JTO: { sector: "defi", label: "Jito" },
  LISTA: { sector: "defi", label: "Lista DAO" },
  MAV: { sector: "defi", label: "Maverick" },
  MORPHO: { sector: "defi", label: "Morpho" },
  OX: { sector: "defi", label: "Open Exchange" },
  RDNT: { sector: "defi", label: "Radiant" },
  REZ: { sector: "defi", label: "Renzo" },
  RESOLV: { sector: "defi", label: "Resolv" },
  RSR: { sector: "defi", label: "Reserve" },
  RUNE: { sector: "defi", label: "THORChain" },
  SKY: { sector: "defi", label: "Sky (MakerDAO)" },
  STG: { sector: "defi", label: "Stargate" },
  SUSHI: { sector: "defi", label: "SushiSwap" },
  SYRUP: { sector: "defi", label: "Maple Finance" },
  UMA: { sector: "defi", label: "UMA" },
  UNIBOT: { sector: "defi", label: "Unibot" },
  USUAL: { sector: "defi", label: "Usual" },
  WLD: { sector: "defi", label: "Worldcoin" },
  WLFI: { sector: "defi", label: "World Liberty Fi" },

  // ── Memecoins ────────────────────────────────────────────────────────────
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
  // Additional memes
  ANIME: { sector: "meme", label: "Anime" },
  APE: { sector: "meme", label: "ApeCoin" },
  BABY: { sector: "meme", label: "Baby" },
  BANANA: { sector: "meme", label: "Banana" },
  BOME: { sector: "meme", label: "Book of Meme" },
  CHILLGUY: { sector: "meme", label: "Chill Guy" },
  DOOD: { sector: "meme", label: "Doodles" },
  GOAT: { sector: "meme", label: "GOAT" },
  GRIFFAIN: { sector: "meme", label: "Griffain" },
  HMSTR: { sector: "meme", label: "Hamster Kombat" },
  JELLY: { sector: "meme", label: "Jelly" },
  kDOGS: { sector: "meme", label: "Dogs" },
  kFLOKI: { sector: "meme", label: "Floki" },
  kLUNC: { sector: "meme", label: "LUNC" },
  kNEIRO: { sector: "meme", label: "Neiro" },
  LAUNCHCOIN: { sector: "meme", label: "Launchcoin" },
  MELANIA: { sector: "meme", label: "Melania" },
  MEME: { sector: "meme", label: "Memecoin" },
  MEW: { sector: "meme", label: "cat in a dogs world" },
  MOODENG: { sector: "meme", label: "Moo Deng" },
  MYRO: { sector: "meme", label: "Myro" },
  NEIROETH: { sector: "meme", label: "Neiro (ETH)" },
  PANDORA: { sector: "meme", label: "Pandora" },
  PENGU: { sector: "meme", label: "Pudgy Penguins" },
  PEOPLE: { sector: "meme", label: "ConstitutionDAO" },
  PUMP: { sector: "meme", label: "Pump" },
  PURR: { sector: "meme", label: "Purr" },
  SHIA: { sector: "meme", label: "Shia" },
  TST: { sector: "meme", label: "Test (TST)" },
  TURBO: { sector: "meme", label: "Turbo" },
  VINE: { sector: "meme", label: "Vine" },
  YZY: { sector: "meme", label: "Yeezy" },

  // ── AI & Data ─────────────────────────────────────────────────────────────
  FET: { sector: "ai", label: "Fetch.ai" },
  RENDER: { sector: "ai", label: "Render" },
  RNDR: { sector: "ai", label: "Render (RNDR)" },
  TAO: { sector: "ai", label: "Bittensor" },
  AR: { sector: "ai", label: "Arweave" },
  VIRTUAL: { sector: "ai", label: "Virtuals" },
  AIXBT: { sector: "ai", label: "AIXBT" },
  GRASS: { sector: "ai", label: "Grass" },
  IO: { sector: "ai", label: "io.net" },
  // Additional AI
  AI: { sector: "ai", label: "Sleepless AI" },
  AI16Z: { sector: "ai", label: "ai16z" },
  HYPER: { sector: "ai", label: "Hyper" },
  IP: { sector: "ai", label: "Story Protocol" },
  KAITO: { sector: "ai", label: "Kaito" },
  PROMPT: { sector: "ai", label: "Prompt" },
  WCT: { sector: "ai", label: "WalletConnect" },
  ZEREBRO: { sector: "ai", label: "Zerebro" },
  "0G": { sector: "ai", label: "0G Labs" },

  // ── Gaming ───────────────────────────────────────────────────────────────
  IMX: { sector: "gaming", label: "Immutable X" },
  GALA: { sector: "gaming", label: "Gala" },
  AXS: { sector: "gaming", label: "Axie Infinity" },
  PIXEL: { sector: "gaming", label: "Pixels" },
  SUPER: { sector: "gaming", label: "SuperVerse" },
  // Additional gaming
  ACE: { sector: "gaming", label: "Fusionist" },
  BIGTIME: { sector: "gaming", label: "BigTime" },
  CATI: { sector: "gaming", label: "Catizen" },
  GMT: { sector: "gaming", label: "STEPN" },
  ILV: { sector: "gaming", label: "Illuvium" },
  MAVIA: { sector: "gaming", label: "Heroes of Mavia" },
  NOT: { sector: "gaming", label: "Notcoin" },
  RLB: { sector: "gaming", label: "Rollbit" },
  SAND: { sector: "gaming", label: "The Sandbox" },
  XAI: { sector: "gaming", label: "XAI" },
  YGG: { sector: "gaming", label: "Yield Guild" },

  // ── Infrastructure ───────────────────────────────────────────────────────
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
  // Additional infra
  ALT: { sector: "infra", label: "AltLayer" },
  ARK: { sector: "infra", label: "Ark" },
  AZTEC: { sector: "infra", label: "Aztec" },
  BLAST: { sector: "infra", label: "Blast" },
  BLUR: { sector: "infra", label: "Blur" },
  BLZ: { sector: "infra", label: "Bluzelle" },
  CYBER: { sector: "infra", label: "CyberConnect" },
  FRIEND: { sector: "infra", label: "friend.tech" },
  GAS: { sector: "infra", label: "NEO Gas" },
  HEMI: { sector: "infra", label: "Hemi" },
  INIT: { sector: "infra", label: "Initia" },
  LAYER: { sector: "infra", label: "Layer" },
  LINEA: { sector: "infra", label: "Linea" },
  LIT: { sector: "infra", label: "Lit Protocol" },
  LOOM: { sector: "infra", label: "Loom" },
  MANTA: { sector: "infra", label: "Manta Network" },
  ME: { sector: "infra", label: "Magic Eden" },
  MERL: { sector: "infra", label: "Merlin Chain" },
  MNT: { sector: "infra", label: "Mantle" },
  NFTI: { sector: "infra", label: "NFTI" },
  NIL: { sector: "infra", label: "Nil Foundation" },
  OGN: { sector: "infra", label: "Origin Protocol" },
  OMNI: { sector: "infra", label: "Omni Network" },
  ORBI: { sector: "infra", label: "Orbiter" },
  ORBS: { sector: "infra", label: "Orbs" },
  ORDI: { sector: "infra", label: "Ordinals" },
  POLYX: { sector: "infra", label: "Polymesh" },
  PROVE: { sector: "infra", label: "Prove" },
  REQ: { sector: "infra", label: "Request Network" },
  SAGA: { sector: "infra", label: "Saga" },
  SCR: { sector: "infra", label: "Scroll" },
  STRAX: { sector: "infra", label: "Stratis" },
  TNSR: { sector: "infra", label: "Tensor" },
  TRB: { sector: "infra", label: "Tellor" },
  ZEN: { sector: "infra", label: "Horizen" },
  ZRO: { sector: "infra", label: "LayerZero" },
  ZORA: { sector: "infra", label: "Zora" },

  // ── Indices (perp) ───────────────────────────────────────────────────────
  SPX: { sector: "indices", label: "S&P 500" },

  // ── Commodities (perp) ───────────────────────────────────────────────────
  PAXG: { sector: "commodities", label: "Gold (PAXG)" },
};

// HIP-3 builder-deployed perp dexes to include (in priority order for dedup)
export const BUILDER_DEXES = ["xyz", "vntl", "km", "cash", "flx"];

// Builder perp asset → sector mapping
// Key: "dex:ticker" (e.g. "xyz:TSLA")
export const HL_BUILDER_PERP_MAP: Record<string, { sector: Sector; label: string }> = {
  // ── xyz dex — Stocks ───────────────────────────────────────────────────────
  "xyz:TSLA":     { sector: "stocks",      label: "Tesla" },
  "xyz:NVDA":     { sector: "stocks",      label: "Nvidia" },
  "xyz:HOOD":     { sector: "stocks",      label: "Robinhood" },
  "xyz:INTC":     { sector: "stocks",      label: "Intel" },
  "xyz:PLTR":     { sector: "stocks",      label: "Palantir" },
  "xyz:COIN":     { sector: "stocks",      label: "Coinbase" },
  "xyz:META":     { sector: "stocks",      label: "Meta" },
  "xyz:AAPL":     { sector: "stocks",      label: "Apple" },
  "xyz:MSFT":     { sector: "stocks",      label: "Microsoft" },
  "xyz:ORCL":     { sector: "stocks",      label: "Oracle" },
  "xyz:GOOGL":    { sector: "stocks",      label: "Alphabet" },
  "xyz:AMZN":     { sector: "stocks",      label: "Amazon" },
  "xyz:AMD":      { sector: "stocks",      label: "AMD" },
  "xyz:MU":       { sector: "stocks",      label: "Micron" },
  "xyz:SNDK":     { sector: "stocks",      label: "SanDisk" },
  "xyz:MSTR":     { sector: "stocks",      label: "Strategy (MSTR)" },
  "xyz:CRCL":     { sector: "stocks",      label: "Circle" },
  "xyz:NFLX":     { sector: "stocks",      label: "Netflix" },
  "xyz:COST":     { sector: "stocks",      label: "Costco" },
  "xyz:LLY":      { sector: "stocks",      label: "Eli Lilly" },
  "xyz:SKHX":     { sector: "stocks",      label: "SK Hynix" },
  "xyz:TSM":      { sector: "stocks",      label: "TSMC" },
  "xyz:RIVN":     { sector: "stocks",      label: "Rivian" },
  "xyz:BABA":     { sector: "stocks",      label: "Alibaba" },
  "xyz:SMSN":     { sector: "stocks",      label: "Samsung Electronics" },
  "xyz:CRWV":     { sector: "stocks",      label: "CoreWeave" },
  "xyz:GME":      { sector: "stocks",      label: "GameStop" },
  "xyz:SOFTBANK": { sector: "stocks",      label: "SoftBank" },
  "xyz:HYUNDAI":  { sector: "stocks",      label: "Hyundai Motor" },
  "xyz:KIOXIA":   { sector: "stocks",      label: "Kioxia" },
  "xyz:HIMS":     { sector: "stocks",      label: "Hims & Hers" },
  "xyz:DKNG":     { sector: "stocks",      label: "DraftKings" },
  // ── xyz dex — Commodities ─────────────────────────────────────────────────
  "xyz:GOLD":      { sector: "commodities", label: "Gold" },
  "xyz:SILVER":    { sector: "commodities", label: "Silver" },
  "xyz:CL":        { sector: "commodities", label: "WTI Crude Oil" },
  "xyz:BRENTOIL":  { sector: "commodities", label: "Brent Crude Oil" },
  "xyz:COPPER":    { sector: "commodities", label: "Copper" },
  "xyz:NATGAS":    { sector: "commodities", label: "Natural Gas" },
  "xyz:URANIUM":   { sector: "commodities", label: "Uranium" },
  "xyz:ALUMINIUM": { sector: "commodities", label: "Aluminium" },
  "xyz:PLATINUM":  { sector: "commodities", label: "Platinum" },
  "xyz:PALLADIUM": { sector: "commodities", label: "Palladium" },
  // ── xyz dex — Indices & ETFs ──────────────────────────────────────────────
  "xyz:XYZ100":  { sector: "indices", label: "XYZ 100" },
  "xyz:SP500":   { sector: "indices", label: "S&P 500" },
  "xyz:VIX":     { sector: "indices", label: "VIX" },
  "xyz:DXY":     { sector: "indices", label: "US Dollar Index" },
  "xyz:JPY":     { sector: "forex",   label: "USD/JPY" },
  "xyz:EUR":     { sector: "forex",   label: "EUR/USD" },
  "xyz:KR200":   { sector: "indices", label: "KOSPI 200" },
  "xyz:JP225":   { sector: "indices", label: "Nikkei 225" },
  "xyz:EWY":     { sector: "indices", label: "iShares MSCI Korea ETF" },
  "xyz:EWJ":     { sector: "indices", label: "iShares MSCI Japan ETF" },
  "xyz:USAR":    { sector: "stocks",  label: "USA Rare Earth" },
  "xyz:URNM":    { sector: "commodities", label: "Sprott Uranium Miners ETF" },
  // ── vntl dex — Pre-IPO & Thematic Baskets ─────────────────────────────────
  "vntl:SPACEX":    { sector: "preipo",      label: "SpaceX" },
  "vntl:OPENAI":    { sector: "preipo",      label: "OpenAI" },
  "vntl:ANTHROPIC": { sector: "preipo",      label: "Anthropic" },
  "vntl:MAG7":      { sector: "indices",     label: "Magnificent 7" },
  "vntl:SEMIS":     { sector: "indices",     label: "Semiconductors" },
  "vntl:ROBOT":     { sector: "indices",     label: "Robotics" },
  "vntl:INFOTECH":  { sector: "indices",     label: "Info Tech" },
  "vntl:NUCLEAR":   { sector: "indices",     label: "Nuclear Energy" },
  "vntl:DEFENSE":   { sector: "indices",     label: "Defense" },
  "vntl:ENERGY":    { sector: "indices",     label: "Energy" },
  "vntl:BIOTECH":   { sector: "indices",     label: "Biotech" },
  "vntl:GOLDJM":    { sector: "commodities", label: "Gold Jr. Miners (GDXJ)" },
  "vntl:SILVERJM":  { sector: "commodities", label: "Silver Jr. Miners (SILJ)" },
  // ── km dex — unique assets not in xyz ─────────────────────────────────────
  "km:US500":     { sector: "indices",     label: "US 500" },
  "km:USTECH":    { sector: "indices",     label: "US Tech 100" },
  "km:SMALL2000": { sector: "indices",     label: "Russell 2000" },
  "km:USBOND":    { sector: "indices",     label: "US Bonds" },
  "km:USENERGY":  { sector: "indices",     label: "US Energy" },
  "km:GLDMINE":   { sector: "commodities", label: "Gold Miners" },
  "km:SEMI":      { sector: "indices",     label: "Semiconductors (KM)" },
  "km:TENCENT":   { sector: "stocks",      label: "Tencent" },
  "km:XIAOMI":    { sector: "stocks",      label: "Xiaomi" },
  "km:RTX":       { sector: "stocks",      label: "Raytheon" },
  "km:BMNR":      { sector: "stocks",      label: "BM&R" },
  "km:JPN225":    { sector: "indices",     label: "Nikkei 225 (KM)" },
  "km:USOIL":     { sector: "commodities", label: "US Oil (KM)" },
  "km:BABA":      { sector: "stocks",      label: "Alibaba (KM)" },
  "km:EUR":       { sector: "forex",       label: "EUR/USD (KM)" },
  // ── cash dex — unique assets not already covered ──────────────────────────
  "cash:WTI":    { sector: "commodities", label: "WTI Oil (cash)" },
  "cash:KWEB":   { sector: "indices",     label: "China Internet ETF" },
  "cash:USA500": { sector: "indices",     label: "US 500 (cash)" },
  // ── flx dex (Felix) — assets not already covered by xyz/standard HL ──────
  // Note: TSLA/NVDA/COIN/CRCL/GOLD/SILVER/COPPER/PALLADIUM/PLATINUM are
  // all deduplicated against xyz dex; BTC/XMR/USDE deduplicated against
  // standard HL perps. Only truly unique Felix tickers appear below.
  "flx:OIL":    { sector: "commodities", label: "WTI Crude Oil (Felix)" },
  "flx:GAS":    { sector: "commodities", label: "Natural Gas (Felix)" },
  "flx:USA100": { sector: "indices",     label: "Nasdaq 100 (Felix)" },
  "flx:USA500": { sector: "indices",     label: "S&P 500 (Felix)" },
  // Duplicates handled by dedup — entries here for completeness / future use
  "flx:TSLA":      { sector: "stocks",      label: "Tesla (Felix)" },
  "flx:NVDA":      { sector: "stocks",      label: "Nvidia (Felix)" },
  "flx:CRCL":      { sector: "stocks",      label: "Circle (Felix)" },
  "flx:COIN":      { sector: "stocks",      label: "Coinbase (Felix)" },
  "flx:GOLD":      { sector: "commodities", label: "Gold (Felix)" },
  "flx:SILVER":    { sector: "commodities", label: "Silver (Felix)" },
  "flx:COPPER":    { sector: "commodities", label: "Copper (Felix)" },
  "flx:PALLADIUM": { sector: "commodities", label: "Palladium (Felix)" },
  "flx:PLATINUM":  { sector: "commodities", label: "Platinum (Felix)" },
  "flx:BTC":       { sector: "majors",      label: "Bitcoin (Felix)" },
  "flx:XMR":       { sector: "l1",          label: "Monero (Felix)" },
  "flx:USDE":      { sector: "crypto-alt",  label: "USDe (Felix)" },
};

// Top holdings for index/ETF/basket assets — shown as a collapsible list in the detail modal
export const ASSET_HOLDINGS: Record<string, string[]> = {
  // ── Thematic baskets (vntl / xyz dex) ────────────────────────────────────
  MAG7: [
    "Apple (AAPL)", "Microsoft (MSFT)", "Nvidia (NVDA)", "Alphabet (GOOGL)",
    "Amazon (AMZN)", "Meta (META)", "Tesla (TSLA)",
  ],
  SEMIS: [
    "Nvidia (NVDA)", "TSMC (TSM)", "Broadcom (AVGO)", "ASML Holding (ASML)",
    "AMD (AMD)", "Qualcomm (QCOM)", "Texas Instruments (TXN)", "Micron (MU)",
    "Applied Materials (AMAT)", "Intel (INTC)",
  ],
  SEMI: [
    "Nvidia (NVDA)", "TSMC (TSM)", "Broadcom (AVGO)", "ASML Holding (ASML)",
    "AMD (AMD)", "Qualcomm (QCOM)", "Texas Instruments (TXN)", "Micron (MU)",
    "Applied Materials (AMAT)", "Intel (INTC)",
  ],
  ROBOT: [
    "ABB Ltd (ABB)", "Keyence (6861.T)", "Fanuc (6954.T)", "Intuitive Surgical (ISRG)",
    "Rockwell Automation (ROK)", "Zebra Technologies (ZBRA)", "Cognex (CGNX)",
    "Teradyne (TER)", "Nvidia (NVDA)", "Honeywell (HON)",
  ],
  INFOTECH: [
    "Microsoft (MSFT)", "Apple (AAPL)", "Nvidia (NVDA)", "Broadcom (AVGO)",
    "Oracle (ORCL)", "AMD (AMD)", "Salesforce (CRM)", "Accenture (ACN)",
    "Texas Instruments (TXN)", "ServiceNow (NOW)",
  ],
  NUCLEAR: [
    "Constellation Energy (CEG)", "Vistra Corp (VST)", "NRG Energy (NRG)",
    "Cameco (CCJ)", "GE Vernova (GEV)", "Uranium Energy (UEC)",
    "NexGen Energy (NXE)", "Denison Mines (DNN)", "Energy Fuels (UUUU)",
    "BWX Technologies (BWXT)",
  ],
  DEFENSE: [
    "Palantir Technologies (PLTR)", "CrowdStrike (CRWD)", "Booz Allen Hamilton (BAH)",
    "Leidos Holdings (LDOS)", "CACI International (CACI)", "Science Applications (SAIC)",
    "Parsons Corp (PSN)", "Palo Alto Networks (PANW)", "L3Harris Technologies (LHX)",
    "Northrop Grumman (NOC)",
  ],
  ENERGY: [
    "ExxonMobil (XOM)", "Chevron (CVX)", "ConocoPhillips (COP)",
    "EOG Resources (EOG)", "Schlumberger (SLB)", "Pioneer Natural (PXD)",
    "Phillips 66 (PSX)", "Valero Energy (VLO)", "Occidental Petroleum (OXY)",
    "Halliburton (HAL)",
  ],
  BIOTECH: [
    "Vertex Pharmaceuticals (VRTX)", "Regeneron (REGN)", "Moderna (MRNA)",
    "BioMarin (BMRN)", "Neurocrine (NBIX)", "Incyte (INCY)",
    "Exact Sciences (EXAS)", "Arctus Biotherapeutics (RCUS)", "Natera (NTRA)",
    "Blueprint Medicines (BPMC)",
  ],
  USENERGY: [
    "ExxonMobil (XOM)", "Chevron (CVX)", "ConocoPhillips (COP)",
    "EOG Resources (EOG)", "Schlumberger (SLB)", "Marathon Petroleum (MPC)",
    "Phillips 66 (PSX)", "Valero Energy (VLO)", "Occidental Petroleum (OXY)",
    "Pioneer Natural (PXD)",
  ],
  // ── Broad indices ─────────────────────────────────────────────────────────
  SP500: [
    "Apple (AAPL)", "Microsoft (MSFT)", "Nvidia (NVDA)", "Amazon (AMZN)",
    "Meta (META)", "Alphabet (GOOGL)", "Berkshire Hathaway (BRK.B)", "Eli Lilly (LLY)",
    "Broadcom (AVGO)", "JPMorgan Chase (JPM)",
  ],
  USA500: [
    "Apple (AAPL)", "Microsoft (MSFT)", "Nvidia (NVDA)", "Amazon (AMZN)",
    "Meta (META)", "Alphabet (GOOGL)", "Berkshire Hathaway (BRK.B)", "Eli Lilly (LLY)",
    "Broadcom (AVGO)", "JPMorgan Chase (JPM)",
  ],
  US500: [
    "Apple (AAPL)", "Microsoft (MSFT)", "Nvidia (NVDA)", "Amazon (AMZN)",
    "Meta (META)", "Alphabet (GOOGL)", "Berkshire Hathaway (BRK.B)", "Eli Lilly (LLY)",
    "Broadcom (AVGO)", "JPMorgan Chase (JPM)",
  ],
  USTECH: [
    "Microsoft (MSFT)", "Apple (AAPL)", "Nvidia (NVDA)", "Amazon (AMZN)",
    "Alphabet (GOOGL)", "Meta (META)", "Tesla (TSLA)", "Broadcom (AVGO)",
    "Costco (COST)", "AMD (AMD)",
  ],
  SMALL2000: [
    "Sprouts Farmers Market (SFM)", "Fabrinet (FN)", "Onto Innovation (ONTO)",
    "Comfort Systems USA (FIX)", "Abercrombie & Fitch (ANF)", "UFP Technologies (UFPT)",
    "Installed Building Products (IBP)", "Triumph Financial (TBK)", "Kinsale Capital (KNSL)",
    "Applied Industrial (AIT)",
  ],
  KR200: [
    "Samsung Electronics (005930.KS)", "SK Hynix (000660.KS)", "LG Energy Solution (373220.KS)",
    "Samsung Biologics (207940.KS)", "Hyundai Motor (005380.KS)", "POSCO Holdings (005490.KS)",
    "Kakao (035720.KS)", "Naver (035420.KS)", "KB Financial (105560.KS)",
    "Kia Corp (000270.KS)",
  ],
  EWY: [
    "Samsung Electronics (005930.KS)", "SK Hynix (000660.KS)", "LG Energy Solution (373220.KS)",
    "Samsung Biologics (207940.KS)", "Hyundai Motor (005380.KS)", "POSCO Holdings (005490.KS)",
    "Kakao (035720.KS)", "Naver (035420.KS)", "KB Financial (105560.KS)",
    "Kia Corp (000270.KS)",
  ],
  JP225: [
    "Toyota Motor (7203.T)", "Sony Group (6758.T)", "SoftBank Group (9984.T)",
    "Mitsubishi UFJ (8306.T)", "Fast Retailing (9983.T)", "Keyence (6861.T)",
    "Nintendo (7974.T)", "Honda Motor (7267.T)", "KDDI (9433.T)",
    "Recruit Holdings (6098.T)",
  ],
  JPN225: [
    "Toyota Motor (7203.T)", "Sony Group (6758.T)", "SoftBank Group (9984.T)",
    "Mitsubishi UFJ (8306.T)", "Fast Retailing (9983.T)", "Keyence (6861.T)",
    "Nintendo (7974.T)", "Honda Motor (7267.T)", "KDDI (9433.T)",
    "Recruit Holdings (6098.T)",
  ],
  EWJ: [
    "Toyota Motor (7203.T)", "Sony Group (6758.T)", "SoftBank Group (9984.T)",
    "Mitsubishi UFJ (8306.T)", "Fast Retailing (9983.T)", "Keyence (6861.T)",
    "Nintendo (7974.T)", "Honda Motor (7267.T)", "KDDI (9433.T)",
    "Recruit Holdings (6098.T)",
  ],
  USBOND: [
    "U.S. Treasury 20+ Year (TLT)", "U.S. Treasury 7–10 Year (IEF)",
    "U.S. Treasury 1–3 Year (SHY)", "Investment Grade Corp (LQD)",
    "TIPS Inflation-Protected (TIP)", "U.S. Treasury 3–7 Year (IEI)",
    "Agency MBS (MBB)", "Short-Term Corp Bonds (VCSH)",
    "U.S. Treasury Long Bond (GOVT)", "High-Grade Corp (IGLB)",
  ],
  // ── Commodity miners ─────────────────────────────────────────────────────
  GLDMINE: [
    "Newmont (NEM)", "Barrick Gold (GOLD)", "Agnico Eagle (AEM)",
    "Wheaton Precious Metals (WPM)", "Franco-Nevada (FNV)", "Kinross Gold (KGC)",
    "Gold Fields (GFI)", "Alamos Gold (AGI)", "Pan American Silver (PAAS)",
    "Endeavour Mining (EDV)",
  ],
  URNM: [
    "Cameco (CCJ)", "Sprott Physical Uranium Trust (U.UN)", "Energy Fuels (UUUU)",
    "NexGen Energy (NXE)", "Uranium Energy (UEC)", "Denison Mines (DNN)",
    "Paladin Energy (PDN.AX)", "Boss Energy (BOE.AX)", "enCore Energy (EU)",
    "Ur-Energy (URG)",
  ],
  GOLDJM: [
    "Kinross Gold (KGC)", "Alamos Gold (AGI)", "Coeur Mining (CDE)",
    "Hecla Mining (HL)", "SSR Mining (SSRM)", "Eldorado Gold (EGO)",
    "Iamgold (IAG)", "Equinox Gold (EQX)", "Endeavour Mining (EDV)",
    "Wesdome Gold Mines (WDO.TO)",
  ],
  SILVERJM: [
    "First Majestic Silver (AG)", "Pan American Silver (PAAS)", "Coeur Mining (CDE)",
    "Hecla Mining (HL)", "MAG Silver (MAG)", "SilverCrest Metals (SIL.TO)",
    "Silvercorp Metals (SVM)", "Endeavour Silver (EXK)", "Impact Silver (IPT.V)",
    "Fortuna Silver (FSM)",
  ],
  KWEB: [
    "Alibaba Group (BABA)", "Tencent Holdings (700.HK)", "Meituan (3690.HK)",
    "JD.com (JD)", "PDD Holdings (PDD)", "NetEase (NTES)",
    "Baidu (BIDU)", "KE Holdings (BEKE)", "Bilibili (BILI)",
    "Trip.com Group (TCOM)",
  ],
};

// Short descriptions for index/ETF/basket assets shown in the detail modal
export const ASSET_DESCRIPTIONS: Record<string, string> = {
  // ── Indices / ETF equivalents ────────────────────────────────────────────
  XYZ100:   "Modified cap-weighted index of 100 large non-financial U.S. companies — growth and technology focused (Nasdaq 100 equivalent)",
  SP500:    "Free-float cap-weighted index of 500 leading U.S. companies representing ~80% of total U.S. market cap (oracle: SPY)",
  USA500:   "500 largest U.S. companies by market cap across all major sectors (oracle: SPY)",
  US500:    "500 largest U.S. companies by market cap across all major sectors (oracle: SPY)",
  USTECH:   "100 largest non-financial U.S. companies with a technology and high-growth focus (oracle: QQQ)",
  SMALL2000:"~2,000 smaller U.S. publicly traded companies representing the small-cap segment of the U.S. equity market (oracle: IWM)",
  USBOND:   "Long-duration U.S. Treasury bonds with 20+ year maturities — interest rate sensitive, used as an equity hedge (oracle: TLT)",
  KR200:    "KOSPI 200 — cap-weighted index of the 200 largest and most liquid companies on the Korea Stock Exchange",
  JP225:    "Nikkei 225 — price-weighted index of 225 top-rated Tokyo Stock Exchange companies across all Japanese industries",
  JPN225:   "Nikkei 225 — price-weighted index of 225 top-rated Tokyo Stock Exchange companies across all Japanese industries",
  EWY:      "iShares MSCI South Korea ETF — large- and mid-cap South Korean equities",
  EWJ:      "iShares MSCI Japan ETF — large- and mid-cap Japanese equities",
  USAR:     "USA Rare Earth, Inc. — U.S.-based mining, processing, and supply of rare earth and critical minerals (NASDAQ: USAR)",
  KWEB:     "KraneShares CSI China Internet ETF — Chinese internet companies analogous to Google, Meta, Amazon, and similar U.S. giants",
  // ── Thematic baskets (vntl dex, tracking named ETFs) ─────────────────────
  MAG7:     "Tracks the MAGS ETF — equal-weight exposure to the Magnificent Seven: Alphabet, Amazon, Apple, Meta, Microsoft, Nvidia, and Tesla",
  SEMIS:    "Tracks the SMH ETF — semiconductor companies spanning chip design, fabrication, packaging, and equipment manufacturing",
  SEMI:     "Tracks the SOXX ETF — semiconductor value chain including chip design, fabrication, packaging, and equipment manufacturing",
  ROBOT:    "Tracks the BOTZ ETF — global leaders in AI, industrial automation, surgical robotics, and autonomous vehicle technology",
  INFOTECH: "Tracks the XLK ETF — S&P 500 technology sector spanning enterprise software, cloud infrastructure, and hardware manufacturing",
  NUCLEAR:  "Tracks the NLR ETF — full nuclear energy value chain from uranium mining to power generation and reactor technology",
  DEFENSE:  "Tracks the SHLD ETF — tech-driven defense companies in AI-powered cybersecurity, big data analytics, and autonomous defense systems",
  ENERGY:   "Tracks the XLE ETF — largest U.S. companies in oil, gas, and consumable fuels including exploration, production, and refining",
  BIOTECH:  "Tracks the XBI ETF (equal-weight) — biotechnology sector including smaller firms developing next-generation drugs and therapies",
  USENERGY: "U.S.-listed oil, gas, exploration, production, refining, transportation, and energy services companies (oracle: XLE)",
  // ── Commodity miners / royalties ─────────────────────────────────────────
  GLDMINE:  "Tracks the GDX ETF — diversified large- and mid-cap gold mining, exploration, and production companies globally",
  URNM:     "Tracks the URNM ETF — global companies involved in uranium mining, exploration, development, and production",
  GOLDJM:   "Tracks the GDXJ ETF — junior gold miners providing high-beta exposure to new gold discoveries and early-stage production",
  SILVERJM: "Tracks the SILJ ETF — junior silver miners with high-beta exposure to the AI hardware and green energy transition",
};

// Hyperliquid HIP-3 SPOT stocks — @N identifier → info
// These are builder-deployed spot pairs under spotMeta
// Only include HIP-3 spot pairs with reliable pricing (within ~15% of real price)
// Many HIP-3 pairs have low liquidity and stale/inaccurate prices
export const HL_SPOT_STOCKS: Record<string, { ticker: string; sector: Sector; label: string; tokenIndex: number }> = {
  "@264": { ticker: "TSLA", sector: "stocks", label: "Tesla", tokenIndex: 407 },
  "@265": { ticker: "SLV", sector: "commodities", label: "Silver (SLV)", tokenIndex: 411 },
  "@266": { ticker: "GOOGL", sector: "stocks", label: "Alphabet", tokenIndex: 412 },
  "@268": { ticker: "AAPL", sector: "stocks", label: "Apple", tokenIndex: 413 },
  "@271": { ticker: "HOOD", sector: "stocks", label: "Robinhood", tokenIndex: 415 },
  "@276": { ticker: "GLD", sector: "commodities", label: "Gold (GLD)", tokenIndex: 432 },
  "@279": { ticker: "SPY", sector: "indices", label: "SPY ETF", tokenIndex: 420 },
  "@280": { ticker: "AMZN", sector: "stocks", label: "Amazon", tokenIndex: 421 },
  "@287": { ticker: "META", sector: "stocks", label: "Meta", tokenIndex: 422 },
  "@288": { ticker: "QQQ", sector: "indices", label: "Nasdaq ETF (QQQ)", tokenIndex: 426 },
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

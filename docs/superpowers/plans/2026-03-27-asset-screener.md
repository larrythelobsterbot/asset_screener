# Asset Screener Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a real-time multi-asset screener at assets.lekker.design that displays Hyperliquid perps and CoinGecko crypto in a heatmap with technical signal scanning.

**Architecture:** Next.js 14 App Router with server-side API routes that fetch from Hyperliquid Info API and CoinGecko, compute technical indicators, and cache results in-memory. Client polls API routes for fresh data. Deployed via pm2 + Nginx.

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, lightweight-charts (TradingView), pm2, Nginx

**Important Discovery:** Hyperliquid perps are almost entirely crypto. Only SPX exists as a traditional asset. PAXG serves as gold proxy. The screener will organize Hyperliquid perps into sectors (L1s, DeFi, Memecoins, AI, Gaming, Infrastructure, Traditional) plus CoinGecko top coins.

**Spec:** `docs/superpowers/specs/2026-03-27-asset-screener-design.md`

---

## File Structure

```
screener/
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── next.config.ts
├── postcss.config.mjs
├── src/
│   ├── app/
│   │   ├── layout.tsx              # Root layout, fonts, global styles
│   │   ├── page.tsx                # Main page — heatmap + signal scanner
│   │   ├── globals.css             # Tailwind directives + custom vars
│   │   └── api/
│   │       ├── markets/route.ts    # GET /api/markets — all assets + prices
│   │       ├── signals/route.ts    # GET /api/signals — active signals
│   │       ├── asset/[symbol]/route.ts  # GET /api/asset/:symbol — detail data
│   │       └── macro/route.ts      # GET /api/macro — macro bar data
│   ├── config/
│   │   └── sectors.ts              # Sector classification map + colors
│   ├── lib/
│   │   ├── cache.ts                # In-memory TTL cache
│   │   ├── hyperliquid.ts          # Hyperliquid API client
│   │   ├── coingecko.ts            # CoinGecko API client
│   │   ├── indicators.ts           # RSI, MACD, EMA, MA computations
│   │   └── signals.ts              # Signal detection logic
│   └── components/
│       ├── MacroBar.tsx            # Top macro indicators bar
│       ├── Heatmap.tsx             # Sector-grouped heatmap grid
│       ├── HeatmapTile.tsx         # Individual asset tile
│       ├── SignalScanner.tsx        # Signal feed + table container
│       ├── SignalFeed.tsx           # Chronological signal cards
│       ├── SignalTable.tsx          # Sortable signal table
│       ├── AssetDetailModal.tsx     # Detail popup modal
│       ├── PriceChart.tsx           # lightweight-charts wrapper
│       └── TimeframeToggle.tsx      # 1H/4H/24H/7D pill buttons
```

---

### Task 1: Scaffold Next.js Project

**Files:**
- Create: `screener/package.json`, `screener/tsconfig.json`, `screener/next.config.ts`, `screener/tailwind.config.ts`, `screener/postcss.config.mjs`
- Create: `screener/src/app/layout.tsx`, `screener/src/app/page.tsx`, `screener/src/app/globals.css`

- [ ] **Step 1: Initialize Next.js project**

```bash
cd /home/muffinman/asset_screener
npx create-next-app@14 screener --typescript --tailwind --eslint --app --src-dir --no-import-alias
```

Accept defaults. This creates the full scaffold.

- [ ] **Step 2: Install dependencies**

```bash
cd /home/muffinman/asset_screener/screener
npm install lightweight-charts
```

- [ ] **Step 3: Configure Tailwind for dark theme**

Update `screener/tailwind.config.ts` to extend with custom colors:

```typescript
import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        base: "#0A0A0F",
        surface: "#111827",
        "surface-light": "#1F2937",
        "sector-tech": "#3B82F6",
        "sector-commodity": "#F59E0B",
        "sector-preipo": "#8B5CF6",
        "sector-major": "#06B6D4",
        "sector-alt": "#F43F5E",
        "sector-defi": "#10B981",
        "sector-meme": "#EC4899",
        "sector-ai": "#A78BFA",
        "sector-gaming": "#F97316",
        "sector-infra": "#64748B",
        "sector-traditional": "#FCD34D",
        positive: "#22C55E",
        negative: "#EF4444",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)"],
        mono: ["var(--font-geist-mono)"],
      },
    },
  },
  plugins: [],
};
export default config;
```

- [ ] **Step 4: Set up globals.css**

Replace `screener/src/app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --background: #0A0A0F;
  --foreground: #F9FAFB;
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-geist-sans), system-ui, sans-serif;
}

/* Noise texture overlay */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: 0.03;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
}

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
```

- [ ] **Step 5: Set up root layout**

Replace `screener/src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Asset Screener | Lekker",
  description: "Real-time multi-asset screener with technical signals",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="antialiased min-h-screen bg-base text-white">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Verify it builds**

```bash
cd /home/muffinman/asset_screener/screener
npm run build
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /home/muffinman/asset_screener
git add screener/
git commit -m "feat: scaffold Next.js project with Tailwind dark theme"
```

---

### Task 2: Sector Configuration

**Files:**
- Create: `screener/src/config/sectors.ts`

- [ ] **Step 1: Create sector classification**

```typescript
// screener/src/config/sectors.ts

export type Sector =
  | "l1"
  | "defi"
  | "meme"
  | "ai"
  | "gaming"
  | "infra"
  | "traditional"
  | "crypto-major"
  | "crypto-alt";

export interface SectorConfig {
  id: Sector;
  label: string;
  color: string;
}

export const SECTORS: Record<Sector, SectorConfig> = {
  l1: { id: "l1", label: "Layer 1s", color: "#3B82F6" },
  defi: { id: "defi", label: "DeFi", color: "#10B981" },
  meme: { id: "meme", label: "Memecoins", color: "#EC4899" },
  ai: { id: "ai", label: "AI & Data", color: "#A78BFA" },
  gaming: { id: "gaming", label: "Gaming", color: "#F97316" },
  infra: { id: "infra", label: "Infrastructure", color: "#64748B" },
  traditional: { id: "traditional", label: "Traditional", color: "#FCD34D" },
  "crypto-major": { id: "crypto-major", label: "Crypto Majors", color: "#06B6D4" },
  "crypto-alt": { id: "crypto-alt", label: "Crypto Alts", color: "#F43F5E" },
};

// Hyperliquid perp ticker → sector mapping
// Only map assets we want to display. Unmapped perps are excluded.
export const HL_SECTOR_MAP: Record<string, { sector: Sector; label: string }> = {
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
  // Traditional
  SPX: { sector: "traditional", label: "S&P 500" },
  PAXG: { sector: "traditional", label: "Gold (PAXG)" },
};

// CoinGecko ID → display info (for assets NOT already on Hyperliquid)
// Top 10 by mcap = crypto-major, rest = crypto-alt
export const COINGECKO_TOP_IDS = [
  "bitcoin", "ethereum", "tether", "binancecoin", "solana",
  "ripple", "usd-coin", "cardano", "dogecoin", "avalanche-2",
  "chainlink", "polkadot", "tron", "stellar", "litecoin",
  "uniswap", "near", "internet-computer", "render-token", "sui",
];

// Assets already covered by Hyperliquid — skip from CoinGecko to avoid duplicates
export const HL_COVERED_COINGECKO_IDS = new Set([
  "bitcoin", "ethereum", "solana", "avalanche-2", "dogecoin",
  "chainlink", "polkadot", "near", "internet-computer", "render-token",
  "sui", "uniswap",
]);

// Macro indicators
export const MACRO_INDICATORS = [
  { symbol: "DXY", label: "US Dollar Index", source: "static" as const },
  { symbol: "VIX", label: "Volatility Index", source: "static" as const },
  { symbol: "US10Y", label: "US 10Y Yield", source: "static" as const },
  { symbol: "SPX", label: "S&P 500", source: "live" as const },
  { symbol: "PAXG", label: "Gold", source: "live" as const },
];
```

- [ ] **Step 2: Commit**

```bash
cd /home/muffinman/asset_screener
git add screener/src/config/
git commit -m "feat: add sector classification config for HL perps and CoinGecko"
```

---

### Task 3: In-Memory Cache

**Files:**
- Create: `screener/src/lib/cache.ts`

- [ ] **Step 1: Implement TTL cache**

```typescript
// screener/src/lib/cache.ts

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TTLCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  getStale<T>(key: string): T | null {
    const entry = this.store.get(key);
    return entry ? (entry.data as T) : null;
  }

  clear(): void {
    this.store.clear();
  }
}

// Singleton — survives across API route invocations in the same process
export const cache = new TTLCache();
```

- [ ] **Step 2: Commit**

```bash
git add screener/src/lib/cache.ts
git commit -m "feat: add in-memory TTL cache"
```

---

### Task 4: Hyperliquid API Client

**Files:**
- Create: `screener/src/lib/hyperliquid.ts`

- [ ] **Step 1: Implement Hyperliquid client**

```typescript
// screener/src/lib/hyperliquid.ts

import { cache } from "./cache";

const HL_API = "https://api.hyperliquid.xyz/info";

async function hlPost<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(HL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Hyperliquid API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface HLAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string;
  oraclePx: string;
  markPx: string;
  midPx?: string;
  impactPxs?: [string, string];
}

export interface HLMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
  }>;
}

export interface HLMetaAndCtxs {
  meta: HLMeta;
  assetCtxs: HLAssetCtx[];
}

export interface HLCandle {
  t: number;  // open time ms
  T: number;  // close time ms
  o: string;  // open
  h: string;  // high
  l: string;  // low
  c: string;  // close
  v: string;  // volume
  n: number;  // number of trades
}

export async function getMetaAndCtxs(): Promise<HLMetaAndCtxs> {
  const cached = cache.get<HLMetaAndCtxs>("hl:metaAndCtxs");
  if (cached) return cached;

  const data = await hlPost<[HLMeta, HLAssetCtx[]]>({ type: "metaAndAssetCtxs" });
  const result: HLMetaAndCtxs = { meta: data[0], assetCtxs: data[1] };
  cache.set("hl:metaAndCtxs", result, 30_000);
  return result;
}

export async function getCandles(
  coin: string,
  interval: string = "4h",
  count: number = 350
): Promise<HLCandle[]> {
  const cacheKey = `hl:candles:${coin}:${interval}`;
  const cached = cache.get<HLCandle[]>(cacheKey);
  if (cached) return cached;

  const intervalMs: Record<string, number> = {
    "1h": 3600_000,
    "4h": 14400_000,
    "1d": 86400_000,
  };
  const ms = intervalMs[interval] || 14400_000;
  const endTime = Date.now();
  const startTime = endTime - count * ms;

  const data = await hlPost<HLCandle[]>({
    type: "candleSnapshot",
    req: { coin, interval, startTime, endTime },
  });

  cache.set(cacheKey, data, 300_000); // 5 min TTL
  return data;
}

export async function getFundingHistory(
  coin: string,
  hours: number = 168 // 7 days
): Promise<Array<{ coin: string; fundingRate: string; premium: string; time: number }>> {
  const cacheKey = `hl:funding:${coin}`;
  const cached = cache.get<Array<{ coin: string; fundingRate: string; premium: string; time: number }>>(cacheKey);
  if (cached) return cached;

  const endTime = Date.now();
  const startTime = endTime - hours * 3600_000;

  const data = await hlPost<Array<{ coin: string; fundingRate: string; premium: string; time: number }>>({
    type: "fundingHistory",
    coin,
    startTime,
    endTime,
  });

  cache.set(cacheKey, data, 300_000);
  return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add screener/src/lib/hyperliquid.ts
git commit -m "feat: add Hyperliquid API client with caching"
```

---

### Task 5: CoinGecko API Client

**Files:**
- Create: `screener/src/lib/coingecko.ts`

- [ ] **Step 1: Implement CoinGecko client**

```typescript
// screener/src/lib/coingecko.ts

import { cache } from "./cache";
import { COINGECKO_TOP_IDS, HL_COVERED_COINGECKO_IDS } from "@/config/sectors";

const CG_API = "https://api.coingecko.com/api/v3";

export interface CGMarketData {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_1h_in_currency: number | null;
  price_change_percentage_24h_in_currency: number | null;
  price_change_percentage_7d_in_currency: number | null;
  market_cap_rank: number;
}

export interface CGOhlc {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function cgGet<T>(path: string): Promise<T> {
  const res = await fetch(`${CG_API}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new Error("CoinGecko rate limited");
  }
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function getMarkets(): Promise<CGMarketData[]> {
  const cached = cache.get<CGMarketData[]>("cg:markets");
  if (cached) return cached;

  // Only fetch assets not covered by Hyperliquid
  const ids = COINGECKO_TOP_IDS.filter((id) => !HL_COVERED_COINGECKO_IDS.has(id));

  try {
    const data = await cgGet<CGMarketData[]>(
      `/coins/markets?vs_currency=usd&ids=${ids.join(",")}&order=market_cap_desc&sparkline=false&price_change_percentage=1h,24h,7d`
    );
    cache.set("cg:markets", data, 60_000);
    return data;
  } catch (err) {
    const stale = cache.getStale<CGMarketData[]>("cg:markets");
    if (stale) return stale;
    throw err;
  }
}

export async function getOhlc(coinId: string): Promise<CGOhlc[]> {
  const cacheKey = `cg:ohlc:${coinId}`;
  const cached = cache.get<CGOhlc[]>(cacheKey);
  if (cached) return cached;

  try {
    // days=90 returns 4-day interval candles; days=30 returns daily
    const raw = await cgGet<number[][]>(`/coins/${coinId}/ohlc?vs_currency=usd&days=90`);
    const data: CGOhlc[] = raw.map(([timestamp, open, high, low, close]) => ({
      timestamp,
      open,
      high,
      low,
      close,
    }));
    cache.set(cacheKey, data, 300_000);
    return data;
  } catch (err) {
    const stale = cache.getStale<CGOhlc[]>(cacheKey);
    if (stale) return stale;
    throw err;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add screener/src/lib/coingecko.ts
git commit -m "feat: add CoinGecko API client with rate-limit fallback"
```

---

### Task 6: Technical Indicators Library

**Files:**
- Create: `screener/src/lib/indicators.ts`

- [ ] **Step 1: Implement indicator calculations**

Implement RSI(14), MACD(12,26,9), EMA, SMA computations. All functions take arrays of closing prices.

```typescript
// screener/src/lib/indicators.ts

export function sma(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

export function ema(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      sum += data[i];
      result.push(null);
    } else if (i === period - 1) {
      sum += data[i];
      result.push(sum / period);
    } else {
      const prev = result[i - 1]!;
      result.push(data[i] * k + prev * (1 - k));
    }
  }
  return result;
}

export function rsi(closes: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [];
  if (closes.length < period + 1) return closes.map(() => null);

  let avgGain = 0;
  let avgLoss = 0;

  // First RSI: average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Fill nulls for first `period` entries
  for (let i = 0; i <= period; i++) {
    result.push(i === period ? (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)) : null);
  }

  // Subsequent: smoothed
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return result;
}

export interface MACDResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  sig: number = 9
): MACDResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine.push(emaFast[i]! - emaSlow[i]!);
    } else {
      macdLine.push(null);
    }
  }

  // EMA of MACD line for signal
  const nonNullStart = macdLine.findIndex((v) => v !== null);
  const macdValues = macdLine.slice(nonNullStart).map((v) => v!);
  const signalValues = ema(macdValues, sig);

  const signal: (number | null)[] = new Array(nonNullStart).fill(null);
  signal.push(...signalValues);

  const histogram: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && signal[i] !== null) {
      histogram.push(macdLine[i]! - signal[i]!);
    } else {
      histogram.push(null);
    }
  }

  return { macd: macdLine, signal, histogram };
}

export interface IndicatorSeries {
  rsi: (number | null)[];
  macd: MACDResult;
  ema13: (number | null)[];
  ema25: (number | null)[];
  ema32: (number | null)[];
  ma100: (number | null)[];
  ma300: (number | null)[];
  ema200: (number | null)[];
}

export function computeAllIndicators(closes: number[]): IndicatorSeries {
  return {
    rsi: rsi(closes),
    macd: macd(closes),
    ema13: ema(closes, 13),
    ema25: ema(closes, 25),
    ema32: ema(closes, 32),
    ma100: sma(closes, 100),
    ma300: sma(closes, 300),
    ema200: ema(closes, 200),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add screener/src/lib/indicators.ts
git commit -m "feat: add technical indicator computations (RSI, MACD, EMA, SMA)"
```

---

### Task 7: Signal Detection

**Files:**
- Create: `screener/src/lib/signals.ts`

- [ ] **Step 1: Implement signal detection**

```typescript
// screener/src/lib/signals.ts

import { computeAllIndicators } from "./indicators";

export type SignalType =
  | "rsi_overbought"
  | "rsi_oversold"
  | "macd_bullish"
  | "macd_bearish"
  | "volume_spike"
  | "breakout_up"
  | "breakout_down"
  | "funding_anomaly"
  | "ema_bullish"
  | "ema_bearish"
  | "golden_cross"
  | "death_cross";

export type SignalDirection = "bullish" | "bearish";

export interface Signal {
  symbol: string;
  type: SignalType;
  direction: SignalDirection;
  value: number;
  label: string;
  firedAt: number; // timestamp ms
}

// Event signals: store last fire time to prevent duplicate firing within persistence window
const eventSignalHistory = new Map<string, number>();

const PERSISTENCE: Record<string, number> = {
  macd_bullish: 24 * 3600_000,
  macd_bearish: 24 * 3600_000,
  breakout_up: 24 * 3600_000,
  breakout_down: 24 * 3600_000,
  ema_bullish: 24 * 3600_000,
  ema_bearish: 24 * 3600_000,
  golden_cross: 48 * 3600_000,
  death_cross: 48 * 3600_000,
};

function fireEvent(symbol: string, type: SignalType, direction: SignalDirection, value: number, label: string): Signal | null {
  const key = `${symbol}:${type}`;
  const now = Date.now();
  const lastFired = eventSignalHistory.get(key);
  const persist = PERSISTENCE[type] || 24 * 3600_000;

  if (lastFired && now - lastFired < persist) return null;

  eventSignalHistory.set(key, now);
  return { symbol, type, direction, value, label, firedAt: now };
}

export function detectSignals(
  symbol: string,
  closes: number[],
  volumes: number[],
  highs: number[],
  lows: number[],
  fundingRate?: number
): Signal[] {
  if (closes.length < 30) return [];

  const signals: Signal[] = [];
  const indicators = computeAllIndicators(closes);
  const lastIdx = closes.length - 1;

  // RSI overbought/oversold (state signals — always active while condition holds)
  const rsiVal = indicators.rsi[lastIdx];
  if (rsiVal !== null) {
    if (rsiVal > 70) {
      signals.push({ symbol, type: "rsi_overbought", direction: "bearish", value: rsiVal, label: `RSI Overbought (${rsiVal.toFixed(1)})`, firedAt: Date.now() });
    }
    if (rsiVal < 30) {
      signals.push({ symbol, type: "rsi_oversold", direction: "bullish", value: rsiVal, label: `RSI Oversold (${rsiVal.toFixed(1)})`, firedAt: Date.now() });
    }
  }

  // MACD crossover (event signal)
  const m = indicators.macd;
  if (m.macd[lastIdx] !== null && m.signal[lastIdx] !== null && m.macd[lastIdx - 1] !== null && m.signal[lastIdx - 1] !== null) {
    const prevDiff = m.macd[lastIdx - 1]! - m.signal[lastIdx - 1]!;
    const currDiff = m.macd[lastIdx]! - m.signal[lastIdx]!;
    if (prevDiff < 0 && currDiff >= 0) {
      const s = fireEvent(symbol, "macd_bullish", "bullish", currDiff, "MACD Bullish Cross");
      if (s) signals.push(s);
    }
    if (prevDiff > 0 && currDiff <= 0) {
      const s = fireEvent(symbol, "macd_bearish", "bearish", currDiff, "MACD Bearish Cross");
      if (s) signals.push(s);
    }
  }

  // Volume spike (state signal)
  if (volumes.length >= 21) {
    const avgVol = volumes.slice(lastIdx - 20, lastIdx).reduce((a, b) => a + b, 0) / 20;
    const currVol = volumes[lastIdx];
    if (avgVol > 0 && currVol > 2 * avgVol) {
      signals.push({ symbol, type: "volume_spike", direction: "bullish", value: currVol / avgVol, label: `Volume Spike (${(currVol / avgVol).toFixed(1)}x)`, firedAt: Date.now() });
    }
  }

  // Price breakout (event signal)
  if (highs.length >= 21 && lows.length >= 21) {
    const prevHighs = highs.slice(lastIdx - 20, lastIdx);
    const prevLows = lows.slice(lastIdx - 20, lastIdx);
    const highest = Math.max(...prevHighs);
    const lowest = Math.min(...prevLows);
    if (closes[lastIdx] > highest) {
      const s = fireEvent(symbol, "breakout_up", "bullish", closes[lastIdx], `Price Breakout Up ($${closes[lastIdx].toFixed(2)})`);
      if (s) signals.push(s);
    }
    if (closes[lastIdx] < lowest) {
      const s = fireEvent(symbol, "breakout_down", "bearish", closes[lastIdx], `Price Breakout Down ($${closes[lastIdx].toFixed(2)})`);
      if (s) signals.push(s);
    }
  }

  // Funding rate anomaly (state signal, HL perps only)
  if (fundingRate !== undefined && Math.abs(fundingRate) > 0.0001) {
    signals.push({
      symbol,
      type: "funding_anomaly",
      direction: fundingRate > 0 ? "bearish" : "bullish",
      value: fundingRate,
      label: `Funding ${fundingRate > 0 ? "High" : "Negative"} (${(fundingRate * 100).toFixed(4)}%)`,
      firedAt: Date.now(),
    });
  }

  // EMA crossover: EMA13 vs EMA25 (event signal)
  const e13 = indicators.ema13;
  const e25 = indicators.ema25;
  if (e13[lastIdx] !== null && e25[lastIdx] !== null && e13[lastIdx - 1] !== null && e25[lastIdx - 1] !== null) {
    const prevDiff = e13[lastIdx - 1]! - e25[lastIdx - 1]!;
    const currDiff = e13[lastIdx]! - e25[lastIdx]!;
    if (prevDiff < 0 && currDiff >= 0) {
      const s = fireEvent(symbol, "ema_bullish", "bullish", currDiff, "EMA 13/25 Bullish Cross");
      if (s) signals.push(s);
    }
    if (prevDiff > 0 && currDiff <= 0) {
      const s = fireEvent(symbol, "ema_bearish", "bearish", currDiff, "EMA 13/25 Bearish Cross");
      if (s) signals.push(s);
    }
  }

  // Golden/Death Cross: MA100 vs MA300 (event signal, HL only)
  const ma100 = indicators.ma100;
  const ma300 = indicators.ma300;
  if (ma100[lastIdx] !== null && ma300[lastIdx] !== null && ma100[lastIdx - 1] !== null && ma300[lastIdx - 1] !== null) {
    const prevDiff = ma100[lastIdx - 1]! - ma300[lastIdx - 1]!;
    const currDiff = ma100[lastIdx]! - ma300[lastIdx]!;
    if (prevDiff < 0 && currDiff >= 0) {
      const s = fireEvent(symbol, "golden_cross", "bullish", currDiff, "Golden Cross (MA100/MA300)");
      if (s) signals.push(s);
    }
    if (prevDiff > 0 && currDiff <= 0) {
      const s = fireEvent(symbol, "death_cross", "bearish", currDiff, "Death Cross (MA100/MA300)");
      if (s) signals.push(s);
    }
  }

  return signals;
}
```

- [ ] **Step 2: Commit**

```bash
git add screener/src/lib/signals.ts
git commit -m "feat: add signal detection for all 12 signal types"
```

---

### Task 8: API Routes

**Files:**
- Create: `screener/src/app/api/markets/route.ts`
- Create: `screener/src/app/api/signals/route.ts`
- Create: `screener/src/app/api/asset/[symbol]/route.ts`
- Create: `screener/src/app/api/macro/route.ts`

- [ ] **Step 1: Create markets API route**

`screener/src/app/api/markets/route.ts` — fetches from both Hyperliquid and CoinGecko, merges into unified response with sector, price, changes, volume, funding, OI.

Key logic:
- Call `getMetaAndCtxs()` from hyperliquid.ts
- Call `getMarkets()` from coingecko.ts
- For each HL asset in `HL_SECTOR_MAP`, extract price/volume/funding/OI from assetCtxs
- For each CG asset not in `HL_COVERED_COINGECKO_IDS`, map to crypto-major/crypto-alt
- Return unified array sorted by sector then volume

- [ ] **Step 2: Create signals API route**

`screener/src/app/api/signals/route.ts` — fetches candles for all mapped HL assets, runs `detectSignals()`, returns active signals sorted by timestamp.

Uses a background computation approach: maintains a `signalCache` that gets recomputed when candle data refreshes. Returns cached signals if available.

- [ ] **Step 3: Create asset detail API route**

`screener/src/app/api/asset/[symbol]/route.ts` — returns candle data, computed indicator series, funding history, and current stats for a single asset.

- [ ] **Step 4: Create macro API route**

`screener/src/app/api/macro/route.ts` — returns macro bar values from HL (SPX, PAXG) and static placeholders (DXY, VIX, US10Y).

- [ ] **Step 5: Verify API routes return data**

```bash
cd /home/muffinman/asset_screener/screener
npm run dev &
sleep 3
curl -s http://localhost:3000/api/markets | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Assets: {len(d)}')"
curl -s http://localhost:3000/api/macro | python3 -m json.tool
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add screener/src/app/api/
git commit -m "feat: add API routes for markets, signals, asset detail, and macro"
```

---

### Task 9: Frontend — MacroBar and TimeframeToggle Components

**Files:**
- Create: `screener/src/components/MacroBar.tsx`
- Create: `screener/src/components/TimeframeToggle.tsx`

- [ ] **Step 1: Build MacroBar**

Client component that polls `/api/macro` every 60s. Displays DXY, VIX, US10Y, SPX, Gold in a horizontal strip. Shows value + colored change arrow. "Delayed" badge on static items.

- [ ] **Step 2: Build TimeframeToggle**

Client component with 1H / 4H / 24H / 7D pill buttons. 24H selected by default. Calls `onChange(timeframe)` callback.

- [ ] **Step 3: Commit**

```bash
git add screener/src/components/MacroBar.tsx screener/src/components/TimeframeToggle.tsx
git commit -m "feat: add MacroBar and TimeframeToggle components"
```

---

### Task 10: Frontend — Heatmap Components

**Files:**
- Create: `screener/src/components/Heatmap.tsx`
- Create: `screener/src/components/HeatmapTile.tsx`

- [ ] **Step 1: Build HeatmapTile**

Displays a single asset: ticker, price (mono font), % change. Background color = green/red gradient based on % change intensity. Border-left colored by sector accent. Click triggers `onSelect(symbol)`.

- [ ] **Step 2: Build Heatmap**

Client component that polls `/api/markets` every 30s. Groups assets by sector using `SECTORS` config. Each sector is a block with colored header (sector name + total volume). Within each sector block, equal-sized tiles rendered with flex-wrap. Sector blocks ordered by total volume descending.

Props: `timeframe` (from toggle), `onSelectAsset(symbol)`.

- [ ] **Step 3: Commit**

```bash
git add screener/src/components/Heatmap.tsx screener/src/components/HeatmapTile.tsx
git commit -m "feat: add Heatmap and HeatmapTile components"
```

---

### Task 11: Frontend — Signal Scanner Components

**Files:**
- Create: `screener/src/components/SignalScanner.tsx`
- Create: `screener/src/components/SignalFeed.tsx`
- Create: `screener/src/components/SignalTable.tsx`

- [ ] **Step 1: Build SignalFeed**

Chronological list of signal cards. Each card shows: asset name with sector color dot, signal type badge (colored by bullish/bearish), value, relative timestamp ("2m ago"). Clicking a card calls `onSelectAsset(symbol)`.

- [ ] **Step 2: Build SignalTable**

Sortable table with columns: Asset, Signal, Direction, Value, Time. Click header to sort. Row click calls `onSelectAsset(symbol)`.

- [ ] **Step 3: Build SignalScanner**

Container with Feed/Table toggle tabs. Polls `/api/signals` every 30s. Filter bar with signal type and direction dropdowns.

- [ ] **Step 4: Commit**

```bash
git add screener/src/components/Signal*.tsx
git commit -m "feat: add SignalScanner with feed and table views"
```

---

### Task 12: Frontend — Asset Detail Modal

**Files:**
- Create: `screener/src/components/AssetDetailModal.tsx`
- Create: `screener/src/components/PriceChart.tsx`

- [ ] **Step 1: Build PriceChart**

Client component wrapping lightweight-charts. Dynamic import with `ssr: false`. Renders candlestick series with volume histogram. Overlays line series for each MA/EMA with distinct colors from spec. Accepts candle data and indicator series as props.

- [ ] **Step 2: Build AssetDetailModal**

Modal overlay with backdrop blur. Fetches `/api/asset/[symbol]` on mount. Shows:
- Header: asset name, sector badge, price, 24h change
- PriceChart with indicators
- Stats grid: RSI gauge (colored arc), MACD value, volume
- Perp-only stats (funding, OI, mark/oracle spread) — conditionally rendered
- Active signals list with badges
- Chart timeframe selector (1H / 4H / 1D)
- Close: X button, Escape key handler, backdrop click

- [ ] **Step 3: Commit**

```bash
git add screener/src/components/AssetDetailModal.tsx screener/src/components/PriceChart.tsx
git commit -m "feat: add AssetDetailModal with price chart and indicators"
```

---

### Task 13: Main Page Assembly

**Files:**
- Modify: `screener/src/app/page.tsx`

- [ ] **Step 1: Assemble the main page**

Wire together all components in `page.tsx`:
- MacroBar at top
- TimeframeToggle below macro bar
- Heatmap (grouped, hybrid tiles)
- SignalScanner below heatmap
- AssetDetailModal (shown when asset selected)
- State: selectedTimeframe, selectedAsset (null = modal closed)
- Keyboard shortcuts: 1/2 for tab switching, Escape for modal close

- [ ] **Step 2: Build and verify**

```bash
cd /home/muffinman/asset_screener/screener
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add screener/src/app/page.tsx
git commit -m "feat: assemble main page with all components"
```

---

### Task 14: Deployment — Nginx + PM2 + SSL

**Files:**
- Create: `/etc/nginx/sites-available/assets.lekker.design` (via sudo)

- [ ] **Step 1: Build production**

```bash
cd /home/muffinman/asset_screener/screener
npm run build
```

- [ ] **Step 2: Start with PM2**

```bash
cd /home/muffinman/asset_screener/screener
pm2 start npm --name "asset-screener" -- start
pm2 save
```

- [ ] **Step 3: Create Nginx config**

```nginx
server {
    listen 80;
    server_name assets.lekker.design;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/assets.lekker.design /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

- [ ] **Step 4: SSL with certbot**

```bash
sudo certbot --nginx -d assets.lekker.design
```

- [ ] **Step 5: Verify live**

```bash
curl -s -o /dev/null -w "%{http_code}" https://assets.lekker.design
```

Expected: 200

- [ ] **Step 6: Commit deployment config**

```bash
git add -A
git commit -m "feat: production build and deployment config"
```

---

### Task 15: DNS Configuration

- [ ] **Step 1: Inform user about DNS**

The user needs to add an A record in their DNS provider for `assets.lekker.design` pointing to `187.124.236.128`. This is an external action — provide exact instructions.

**DNS Record:**
- Type: A
- Name: assets
- Value: 187.124.236.128
- TTL: 300 (or auto)

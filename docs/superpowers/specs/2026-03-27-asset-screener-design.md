# Asset Screener — Design Spec

## Overview

A real-time multi-asset screener hosted at `assets.lekker.design` (VPS: 187.124.236.128). Built with Next.js 14 (App Router, TypeScript, Tailwind). Screens Hyperliquid HIP-3 perpetuals (stocks, commodities, pre-IPO) and crypto (CoinGecko). High-end visual design with vibrant colors.

## Data Sources

### Hyperliquid HIP-3 Perpetuals
- **API:** Hyperliquid Info API (REST, no auth required)
- **Base URL:** `https://api.hyperliquid.xyz/info`
- **All requests are POST** with JSON body containing `"type"` field.

#### Endpoints Used

**Asset Discovery:**
```json
POST /info
{"type": "meta"}
```
Returns `universe[]` with all perps. HIP-3 assets identified via hardcoded sector classification map.

**Market Data (all assets at once):**
```json
POST /info
{"type": "allMids"}
```
Returns `{asset: midPrice}` for all perps.

```json
POST /info
{"type": "metaAndAssetCtxs"}
```
Returns meta + per-asset context: funding rate, open interest, 24h volume, mark price, oracle price.

**Candle Data (per asset):**
```json
POST /info
{"type": "candleSnapshot", "req": {"coin": "AAPL", "interval": "4h", "startTime": <unix_ms>, "endTime": <unix_ms>}}
```
Intervals: `"1m"`, `"5m"`, `"15m"`, `"1h"`, `"4h"`, `"1d"`. Returns array of `{t, T, o, h, l, c, v, n}`.

**Candle Lookback:** Fetch 350 candles (4H) to allow MA300 computation with buffer. For assets with <300 candles of history, MA300/EMA200 will show as "N/A".

**Funding Rate History:**
```json
POST /info
{"type": "fundingHistory", "coin": "AAPL", "startTime": <unix_ms>, "endTime": <unix_ms>}
```

#### Rate Limit Strategy
- Max 5 concurrent requests, 100ms delay between batches
- On 429/error: exponential backoff starting at 1s, max 3 retries
- Candle data cached 5min; market data cached 30s

### CoinGecko (Free Tier)
- **API:** CoinGecko Public API v3 (no key)
- **Base URL:** `https://api.coingecko.com/api/v3`
- **Assets:** Top 30 coins by market cap

#### Endpoints Used

**Market Data (batch — 1 call):**
```
GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&sparkline=false&price_change_percentage=1h,24h,7d
```

**OHLC (per asset — for indicator computation):**
```
GET /coins/{id}/ohlc?vs_currency=usd&days=90
```
CoinGecko assets use daily candles for indicators. MA300 exceeds free tier; cap at MA100 and EMA200. MA300 and Golden/Death Cross signals are Hyperliquid-only.

#### Rate Limit Strategy
- Free tier: ~30 calls/min
- Cold start: fetch `/coins/markets` first, then stagger OHLC at 2/sec
- Steady state: refresh `/coins/markets` every 60s, OHLC in rolling batches (6 assets/min)
- On 429: back off 60s, serve stale cache

### Macro Bar
- **SPX, Gold (XAU):** Sourced from Hyperliquid HIP-3 perp prices (real-time)
- **DXY, VIX, US10Y:** Placeholder with "delayed" badge until Twelve Data integration
- Persistent top bar across all views

## Sector Classification

Hardcoded map in `src/config/sectors.ts`:

```typescript
export const SECTOR_MAP: Record<string, { sector: string; label: string }> = {
  // Tech Stocks
  AAPL: { sector: "tech", label: "Apple" },
  TSLA: { sector: "tech", label: "Tesla" },
  NVDA: { sector: "tech", label: "NVIDIA" },
  MSFT: { sector: "tech", label: "Microsoft" },
  AMZN: { sector: "tech", label: "Amazon" },
  GOOGL: { sector: "tech", label: "Google" },
  META: { sector: "tech", label: "Meta" },
  // Commodities
  XAU: { sector: "commodity", label: "Gold" },
  XAG: { sector: "commodity", label: "Silver" },
  WTI: { sector: "commodity", label: "Oil (WTI)" },
  // Pre-IPO — added as HIP-3 lists them
};

// CoinGecko assets: top 10 by mcap = "crypto-major", rest = "crypto-alt"
```

**Sector colors:**
| Sector | Color | Hex |
|--------|-------|-----|
| Tech stocks | Electric blue | #3B82F6 |
| Commodities | Amber/gold | #F59E0B |
| Pre-IPO | Violet | #8B5CF6 |
| Crypto majors | Cyan | #06B6D4 |
| Crypto alts | Rose | #F43F5E |

## Technical Indicators

**Canonical timeframe: 4H candles** for Hyperliquid assets. Daily candles for CoinGecko assets.

### Oscillators
- **RSI(14)** — overbought >70, oversold <30
- **MACD(12,26,9)** — signal = 9-period EMA of MACD line

### Moving Averages
- **EMA 13, EMA 25, EMA 32** — short-term trend cluster
- **MA 100, MA 300** — medium/long-term trend (MA300 Hyperliquid-only)
- **EMA 200** — long-term trend benchmark

### Signals Detected

| # | Signal | Condition | Persistence |
|---|--------|-----------|-------------|
| 1 | RSI Overbought | RSI > 70 | Active while condition holds |
| 2 | RSI Oversold | RSI < 30 | Active while condition holds |
| 3 | MACD Bullish Cross | MACD crosses above Signal | Event — shown for 24h |
| 4 | MACD Bearish Cross | MACD crosses below Signal | Event — shown for 24h |
| 5 | Volume Spike | Volume > 2x avg of prior 20 candles | Active while condition holds |
| 6 | Price Breakout Up | Close > highest high of prior 20 candles | Event — shown for 24h |
| 7 | Price Breakout Down | Close < lowest low of prior 20 candles | Event — shown for 24h |
| 8 | Funding Rate Anomaly | |funding rate| > 0.01% (1 bps) | Active while condition holds |
| 9 | EMA Bullish Cross | EMA13 crosses above EMA25 | Event — shown for 24h |
| 10 | EMA Bearish Cross | EMA13 crosses below EMA25 | Event — shown for 24h |
| 11 | Golden Cross | MA100 crosses above MA300 (HL only) | Event — shown for 48h |
| 12 | Death Cross | MA100 crosses below MA300 (HL only) | Event — shown for 48h |

## Architecture

### Stack
- **Framework:** Next.js 14, App Router, TypeScript
- **Styling:** Tailwind CSS
- **Charting:** lightweight-charts (TradingView) — dynamic import, `ssr: false`, `"use client"`
- **Fonts:** Geist Sans + Geist Mono
- **Deployment:** pm2 + Nginx on VPS

### API Routes

**`GET /api/markets?tf=24h`** — all assets with price, changes (1h/4h/24h/7d), volume, funding, OI, sector

**`GET /api/signals?type=all&direction=all`** — active signals with symbol, type, direction, value, timestamp

**`GET /api/asset/[symbol]`** — candles, indicator series, funding history, stats for detail popup

**`GET /api/macro`** — macro indicator values with source type (live/delayed/static)

### Caching
- In-memory Map with TTL
- Market data: 30s, Candles: 5min, Macro: 60s
- Cold start: background warmup, skeleton UI while loading

### Client Polling
- `/api/markets` every 30s
- `/api/signals` every 30s
- `/api/macro` every 60s
- Detail popup: fetch on open, refresh every 60s while open

## UI Design

### Design Direction
- High-end dark theme (#0A0A0F base) with vibrant sector accents
- Green (#22C55E) positive, red (#EF4444) negative, intensity scales with magnitude
- Geist Sans for UI, Geist Mono for numbers
- Subtle noise texture background

### Layout

#### Macro Bar (Top, Persistent)
- DXY, VIX, US10Y, SPX, Gold with values + change arrows
- "Delayed" badge on non-live items

#### Heatmap View (Default)
- Grouped by sector with sector-colored headers
- Hybrid tile sizing: sector blocks proportional to volume, equal tiles within
- Tile: ticker, price, % change, colored by performance
- Timeframe toggle: 1H / 4H / **24H** (default) / 7D
- Click tile → detail popup

#### Signal Scanner (Below Heatmap)
- Toggle between Feed view (chronological cards) and Table view (sortable columns)
- Filter by signal type, direction, sector
- Feed cards: asset + sector dot, signal badge, direction arrow, value, timestamp

#### Detail Popup (Modal)
- Overlay with backdrop blur, max-width 900px
- Header: asset name, sector badge, price, 24h change
- Chart: lightweight-charts candlestick with overlaid MAs:
  - EMA 13 (#3B82F6), EMA 25 (#F59E0B), EMA 32 (#10B981)
  - MA 100 (#8B5CF6), MA 300 (#F43F5E), EMA 200 (#06B6D4)
  - Volume histogram below
- Stats: RSI gauge, MACD histogram, volume
- Perp-only: funding rate, OI, mark/oracle spread (hidden for CoinGecko)
- Active signals list
- Chart timeframe selector: 1H / 4H / 1D
- Close: X button, Escape, backdrop click

## Deployment

- **Nginx:** `assets.lekker.design` → proxy_pass `localhost:3000`
- **SSL:** Let's Encrypt via certbot
- **PM2:** `pm2 start npm --name asset-screener -- start`
- **DNS:** A record `assets.lekker.design` → `187.124.236.128`

## Out of Scope
- Twelve Data API (placeholder for now)
- User authentication
- Alerts/notifications
- Historical signal backtesting
- WebSocket real-time streaming

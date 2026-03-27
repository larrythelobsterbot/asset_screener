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
Returns `universe[]` with all perps. HIP-3 assets are identified by checking if asset has a `"szDecimals"` field and filtering by a **hardcoded sector classification map** (see Sector Classification below). We maintain a curated list of known HIP-3 tickers rather than trying to auto-detect.

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

**Candle Lookback:** Fetch 350 candles (4H) to allow MA300 computation with buffer. `startTime = now - (350 * 4 * 3600 * 1000)`. For assets with <300 candles of history, MA300/EMA200 will show as "N/A".

**Funding Rate History:**
```json
POST /info
{"type": "fundingHistory", "coin": "AAPL", "startTime": <unix_ms>, "endTime": <unix_ms>}
```

#### Rate Limit Strategy
- Hyperliquid has no published rate limit but is generous for read-only info calls
- Throttle candle fetches: max 5 concurrent requests, 100ms delay between batches
- On 429/error: exponential backoff starting at 1s, max 3 retries
- Candle data cached 5min; market data cached 30s

### CoinGecko (Free Tier)
- **API:** CoinGecko Public API v3 (no key)
- **Base URL:** `https://api.coingecko.com/api/v3`
- **Assets:** Top 30 coins by market cap (reduced from 50 to stay under rate limits)

#### Endpoints Used

**Market Data (batch — 1 call):**
```
GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=30&sparkline=false&price_change_percentage=1h,24h,7d
```
Returns price, volume, market cap, 1h/24h/7d change in one call.

**OHLC (per asset — for indicator computation):**
```
GET /coins/{id}/ohlc?vs_currency=usd&days=90
```
`days=90` returns 4-day interval candles (insufficient for MA300 on sub-daily). **Decision: for CoinGecko assets, compute indicators on daily candles only.** MA300 requires 300 daily candles which exceeds free tier; **cap at MA100 and EMA200 for CoinGecko assets.** MA300 and Golden/Death Cross signals are Hyperliquid-only.

#### Rate Limit Strategy
- Free tier: ~30 calls/min
- **Cold start:** On server boot, fetch `/coins/markets` first (1 call), then stagger OHLC fetches at 2/sec (30 assets = 15 seconds). Background job, not blocking first request.
- **Steady state:** Refresh `/coins/markets` every 60s (1 call). Refresh OHLC in rolling batches: 6 assets per minute, full rotation every 5 minutes.
- On 429: back off 60s, serve stale cache

### Macro Bar
- **SPX, Gold (XAU):** Sourced from Hyperliquid HIP-3 perp prices (real-time)
- **DXY, VIX, US10Y:** Displayed with last-known values + "delayed" badge. Updated via CoinGecko's `/simple/price?ids=...` where proxy coins exist, otherwise static placeholders clearly labeled. These are informational context, not real-time.
- Displayed as a persistent top bar across all views

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
  // Other Equities
  // (added as HIP-3 lists them)
  // Commodities
  XAU: { sector: "commodity", label: "Gold" },
  XAG: { sector: "commodity", label: "Silver" },
  WTI: { sector: "commodity", label: "Oil (WTI)" },
  // Pre-IPO
  // (added as HIP-3 lists them — e.g. upcoming token launches)
};

// CoinGecko assets: top 10 by mcap = "crypto-major", rest = "crypto-alt"
```

**Sector colors:**
| Sector | Color | Hex |
|--------|-------|-----|
| Tech stocks | Electric blue | #3B82F6 |
| Other equities | Amber | #F59E0B |
| Commodities | Emerald | #10B981 |
| Pre-IPO | Violet | #8B5CF6 |
| Crypto majors | Cyan | #06B6D4 |
| Crypto alts | Rose | #F43F5E |

## Technical Indicators

**Canonical timeframe: 4H candles** for all indicator computation on Hyperliquid assets. CoinGecko assets use daily candles (see CoinGecko section above).

### Oscillators
- **RSI(14)** — computed on 4H candles. Overbought >70, oversold <30.
- **MACD(12,26,9)** — computed on 4H candles. Signal = 9-period EMA of MACD line.

### Moving Averages (4H candles for Hyperliquid, daily for CoinGecko)
- **EMA 13, EMA 25, EMA 32** — short-term trend cluster
- **MA 100, MA 300** — medium/long-term trend (MA300 Hyperliquid-only)
- **EMA 200** — long-term trend benchmark

### Signals Detected

All signals computed on 4H candles (Hyperliquid) or daily candles (CoinGecko). Crossover detection: compare candle[i-1] and candle[i] values — cross occurs when relative position flips between consecutive candles.

| # | Signal | Condition | Persistence |
|---|--------|-----------|-------------|
| 1 | RSI Overbought | RSI > 70 | Active while condition holds |
| 2 | RSI Oversold | RSI < 30 | Active while condition holds |
| 3 | MACD Bullish Cross | MACD[i-1] < Signal[i-1] AND MACD[i] >= Signal[i] | Event — fires once, shown for 24h |
| 4 | MACD Bearish Cross | MACD[i-1] > Signal[i-1] AND MACD[i] <= Signal[i] | Event — fires once, shown for 24h |
| 5 | Volume Spike | Current 4H candle volume > 2x avg of prior 20 4H candles | Active while condition holds |
| 6 | Price Breakout Up | Close > highest high of prior 20 4H candles | Event — fires once, shown for 24h |
| 7 | Price Breakout Down | Close < lowest low of prior 20 4H candles | Event — fires once, shown for 24h |
| 8 | Funding Rate Anomaly | \|funding rate\| > 0.01% (1 bps) | Active while condition holds |
| 9 | EMA Bullish Cross | EMA13 crosses above EMA25 (consecutive candle comparison) | Event — shown for 24h |
| 10 | EMA Bearish Cross | EMA13 crosses below EMA25 | Event — shown for 24h |
| 11 | Golden Cross | MA100 crosses above MA300 (Hyperliquid only) | Event — shown for 48h |
| 12 | Death Cross | MA100 crosses below MA300 (Hyperliquid only) | Event — shown for 48h |

**Signal deduplication:** Event-type signals store their fire timestamp. Same signal for same asset cannot fire again within the persistence window. State-type signals (RSI, volume spike, funding) recompute each cycle — active or not.

## Architecture

### Stack
- **Framework:** Next.js 14, App Router, TypeScript
- **Styling:** Tailwind CSS + custom CSS variables for theming
- **Charting:** lightweight-charts (TradingView) — imported via dynamic `import()` with `ssr: false` to avoid SSR errors (browser-only library, must use `"use client"` directive)
- **Fonts:** Geist Sans (display/UI) + Geist Mono (numbers/data) — ships with Next.js, distinctive and sharp
- **Deployment:** pm2 + Nginx reverse proxy on VPS (187.124.236.128)
- **Domain:** assets.lekker.design → 187.124.236.128

### API Routes (Server-Side)

**`GET /api/markets?tf=24h`**
Returns all assets with: symbol, name, sector, price, price changes (1h, 4h, 24h, 7d), volume, funding rate (if perp), OI (if perp), market cap (if CoinGecko).

Price changes computed as:
- **Hyperliquid:** Calculated from candle data. 1H change = compare current price to close of candle 1h ago. 4H/24H/7D same approach.
- **CoinGecko:** 1H, 24H, 7D provided by `/coins/markets` endpoint directly. 4H computed from OHLC data.

**`GET /api/signals?type=all&direction=all`**
Returns active signals: symbol, signal type, direction (bullish/bearish), value, fired_at timestamp. Filterable by query params.

**`GET /api/asset/[symbol]`**
Returns: candle data (350 4H candles), computed indicator series (RSI, MACD, all MAs), funding rate history, current stats. For CoinGecko assets: funding rate and OI fields are `null` (frontend hides them conditionally).

**`GET /api/macro`**
Returns: {symbol, value, change, source: "live"|"delayed"|"static"} for each macro indicator.

### Caching Strategy
- In-memory cache (Map) with TTL
- Market data: 30s TTL
- Candle/OHLC data: 5min TTL
- Macro data: 60s TTL
- Signal state: persisted in memory, recomputed on candle refresh
- **Cold start warmup:** On server boot, a startup function fetches market data and begins staggered candle fetching in the background. First request gets whatever is available; UI shows skeleton for assets still loading.

### Client Polling
- Frontend polls `/api/markets` every 30s
- `/api/signals` every 30s
- `/api/macro` every 60s
- Detail popup fetches `/api/asset/[symbol]` on open, refreshes every 60s while open

## UI Design

### Design Direction
- **High-end, vibrant** — dark theme base (#0A0A0F) with vibrant accent colors per sector
- **Performance colors:** green (#22C55E) for positive, red (#EF4444) for negative, intensity scales with magnitude (0-1% = 30% opacity, 1-3% = 60%, 3%+ = 100%)
- **Typography:** Geist Sans for UI, Geist Mono for all numerical data
- **Background:** Dark with subtle noise texture overlay (CSS grain effect)

### Layout

#### Macro Bar (Top, Persistent)
- Horizontal strip showing DXY, VIX, US10Y, SPX, Gold
- Each with current value + change indicator (arrow + color)
- "Delayed" badge on non-live items
- Subtle separator between items

#### Main Navigation (Tab Bar)
- **Heatmap** (default view)
- **Signals** (scanner results)
- Keyboard shortcuts for switching

#### Heatmap View
- **Grouped by sector** — tech, equities, commodities, pre-IPO, crypto majors, crypto alts
- **Hybrid tile sizing:**
  - Layout: CSS Grid. Each sector is a named grid area.
  - Sector block height proportional to (sector total volume / max sector volume), with min-height 120px.
  - Within each sector: CSS flex-wrap, equal-sized tiles, auto-sizing to fill the sector block.
  - Sector header: sector name + total volume badge, colored with sector accent.
- **Tile content:** asset ticker, price, % change
- **Color:** green/red intensity based on selected timeframe's % change
- **Timeframe toggle:** 1H / 4H / 24H (default) / 7D — pill buttons above the heatmap
- **Click tile** → opens detail popup

#### Signals View
- **Toggle between:**
  - **Feed view** — chronological signal cards, newest first. Each card: asset (with sector color dot), signal type (with icon/badge), direction arrow, value, timestamp. Color-coded by bullish (green) / bearish (red).
  - **Table view** — sortable columns: Asset, Signal, Direction, Value, Time. Filterable by signal type and direction.
- **Filter bar** — filter by signal type (RSI, MACD, Volume, EMA, Funding, Breakout), direction (bullish/bearish), asset class (sector)

#### Detail Popup (Modal)
- Triggered by clicking any asset tile or signal card
- **Overlay modal** with backdrop blur, centered, max-width 900px
- **Content:**
  - Header: asset name, sector badge (colored), current price, 24h change
  - **Chart:** lightweight-charts candlestick (dark theme) with overlaid indicators:
    - EMA 13 (#3B82F6), EMA 25 (#F59E0B), EMA 32 (#10B981)
    - MA 100 (#8B5CF6), MA 300 (#F43F5E), EMA 200 (#06B6D4)
    - Volume histogram below chart
  - **Stats grid:** RSI value + gauge, MACD value/signal/histogram, 24h volume
  - **Perp-only stats** (hidden for CoinGecko assets): funding rate, OI, mark/oracle spread
  - **Active signals:** list of currently firing signals for this asset with badges
  - **Timeframe selector** for chart: 1H / 4H / 1D
- **Error state:** If asset data fails to load, show error message with retry button inside the modal. Don't leave skeleton indefinitely.
- Close with X button, Escape key, or clicking backdrop

#### Keyboard Shortcuts
- `1` / `2` — switch between Heatmap / Signals tabs
- `Escape` — close detail popup
- `?` — show shortcuts modal

## Deployment

### Nginx Config
- Server block for `assets.lekker.design`
- Proxy pass to `localhost:3000` (Next.js)
- SSL via Let's Encrypt (certbot)

### PM2
- `pm2 start npm --name asset-screener -- start`
- Auto-restart on crash
- Log rotation

### DNS
- A record: `assets.lekker.design` → `187.124.236.128`

## Error Handling
- API failures: show last cached data with "stale" indicator badge
- CoinGecko rate limit (429): back off 60s, serve stale cache, log warning
- Hyperliquid down: show error banner at top, retry with exponential backoff (1s, 2s, 4s, max 3 retries)
- No data yet (cold start): skeleton loading states with pulsing animation
- Detail popup load failure: error message + retry button inside modal

## Out of Scope (for now)
- Correlation matrix
- User accounts / auth
- Alerts / notifications
- Historical signal replay
- Mobile-specific responsive optimizations (will be functional but not polished)

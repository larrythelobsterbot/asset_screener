# Asset Screener — Design Spec

## Overview

A real-time multi-asset screener hosted at `assets.lekker.design` (VPS: 187.124.236.128). Built with Next.js 14 (App Router, TypeScript, Tailwind). Screens Hyperliquid HIP-3 perpetuals (stocks, commodities, pre-IPO) and crypto (CoinGecko). High-end visual design with vibrant colors.

## Data Sources

### Hyperliquid HIP-3 Perpetuals
- **API:** Hyperliquid Info API (REST, no auth required)
- **Base URL:** `https://api.hyperliquid.xyz/info`
- **Assets:** All HIP-3 builder-deployed perpetuals — equities (AAPL, TSLA, NVDA, MSFT, AMZN, GOOGL, META, etc.), commodities (XAU, XAG, WTI), pre-IPO tokens
- **Data fetched:**
  - Meta info (all listed perps, asset names, builders)
  - Mark price, oracle price, 24h volume
  - Funding rate (current + historical)
  - Open interest
  - Candle data (1m, 5m, 15m, 1h, 4h, 1d) for indicator computation
- **Rate limits:** Generous, no key needed. Cache server-side with 30s TTL for market data, 5min for candles.

### CoinGecko (Free Tier)
- **API:** CoinGecko Public API v3 (no key)
- **Base URL:** `https://api.coingecko.com/api/v3`
- **Assets:** Top 50 coins by market cap
- **Endpoints:**
  - `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50` — price, volume, market cap, 24h change
  - `/coins/{id}/ohlc?days=30` — OHLC for indicator computation
- **Rate limits:** ~30 calls/min free tier. Cache aggressively (60s market data, 5min OHLC).

### Macro Bar
- DXY, VIX, US10Y, SPX, Gold
- Source from HIP-3 where available (SPX, Gold), otherwise display as static/placeholder with a note
- Displayed as a persistent top bar across all views

## Technical Indicators

Computed server-side from candle data:

### Oscillators
- **RSI(14)** — overbought >70, oversold <30
- **MACD(12,26,9)** — crossovers (signal line cross), histogram direction

### Moving Averages (4H timeframe)
- **EMA 13, EMA 25, EMA 32** — short-term trend cluster
- **MA 100, MA 300** — medium/long-term trend
- **EMA 200** — long-term trend benchmark

### Signals Detected
1. **RSI Overbought** — RSI > 70
2. **RSI Oversold** — RSI < 30
3. **MACD Bullish Cross** — MACD line crosses above signal
4. **MACD Bearish Cross** — MACD line crosses below signal
5. **Volume Spike** — current volume > 2x 20-period average volume
6. **Price Breakout Up** — price breaks above 20-period high
7. **Price Breakout Down** — price breaks below 20-period low
8. **Funding Rate Anomaly** — |funding rate| > 0.01% (1 basis point, configurable)
9. **EMA Bullish Cross** — EMA13 crosses above EMA25
10. **EMA Bearish Cross** — EMA13 crosses below EMA25
11. **Golden Cross** — MA100 crosses above MA300
12. **Death Cross** — MA100 crosses below MA300

## Architecture

### Stack
- **Framework:** Next.js 14, App Router, TypeScript
- **Styling:** Tailwind CSS + custom CSS variables for theming
- **Charting:** lightweight-charts (TradingView) for detail popup
- **Deployment:** pm2 + Nginx reverse proxy on VPS (187.124.236.128)
- **Domain:** assets.lekker.design → 187.124.236.128

### API Routes (Server-Side)
- `GET /api/markets` — all asset prices, volumes, changes across timeframes (1H/4H/24H/7D)
- `GET /api/signals` — all active signals across all assets
- `GET /api/asset/[symbol]` — detailed data for one asset (candles, indicators, funding history)
- `GET /api/macro` — macro indicator values

### Caching Strategy
- In-memory cache (Map) with TTL
- Market data: 30s TTL
- Candle/OHLC data: 5min TTL
- Macro data: 60s TTL
- Background refresh: stale-while-revalidate pattern

### Client Polling
- Frontend polls `/api/markets` every 30s
- `/api/signals` every 30s
- `/api/macro` every 60s
- Detail popup fetches `/api/asset/[symbol]` on open

## UI Design

### Design Direction
- **High-end, vibrant** — dark theme base with vibrant accent colors per sector
- **Color coding by sector:**
  - Tech stocks: electric blue (#3B82F6)
  - Other equities: amber (#F59E0B)
  - Commodities: emerald (#10B981)
  - Pre-IPO: violet (#8B5CF6)
  - Crypto majors: cyan (#06B6D4)
  - Crypto alts: rose (#F43F5E)
- **Performance colors:** green (#22C55E) for positive, red (#EF4444) for negative, intensity scales with magnitude
- **Typography:** Distinctive, non-generic font pairing (display + mono for numbers)
- **Background:** Dark with subtle texture/grain

### Layout

#### Macro Bar (Top, Persistent)
- Horizontal strip showing DXY, VIX, US10Y, SPX, Gold
- Each with current value + change indicator (arrow + color)
- Subtle separator between items

#### Main Navigation (Tab Bar)
- **Heatmap** (default view)
- **Signals** (scanner results)
- Keyboard shortcuts for switching

#### Heatmap View
- **Grouped by sector** — tech, equities, commodities, pre-IPO, crypto majors, crypto alts
- **Hybrid tile sizing** — sector blocks sized by total volume, equal tiles within each sector
- **Tile content:** asset ticker, price, % change
- **Color:** green/red intensity based on selected timeframe
- **Timeframe toggle:** 1H / 4H / 24H (default) / 7D — pill buttons above the heatmap
- **Click tile** → opens detail popup

#### Signals View
- **Toggle between:**
  - **Feed view** — chronological signal cards, newest first. Each card: asset, signal type (with icon/badge), value, timeframe, timestamp. Color-coded by bullish (green) / bearish (red).
  - **Table view** — sortable columns: Asset, Signal, Direction, Value, Timeframe, Time. Filterable by signal type and direction.
- **Filter bar** — filter by signal type (RSI, MACD, Volume, etc.), direction (bullish/bearish), asset class

#### Detail Popup (Modal)
- Triggered by clicking any asset tile or signal card
- **Overlay modal** with backdrop blur
- **Content:**
  - Header: asset name, sector badge, current price, 24h change
  - **Chart:** lightweight-charts candlestick with overlaid indicators:
    - EMA 13 (color 1), EMA 25 (color 2), EMA 32 (color 3)
    - MA 100 (color 4), MA 300 (color 5), EMA 200 (color 6)
    - Volume bars below
  - **Stats grid:** RSI value, MACD value/signal/histogram, funding rate, OI, 24h volume
  - **Active signals:** list of currently firing signals for this asset
  - **Timeframe selector** for chart: 1H / 4H / 1D
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
- API failures: show last cached data with "stale" indicator
- CoinGecko rate limit: graceful degradation, show cached data
- Hyperliquid down: show error banner, retry with backoff
- No data yet: skeleton loading states

## Out of Scope (for now)
- Correlation matrix
- User accounts / auth
- Alerts / notifications
- Historical signal replay
- Mobile-specific responsive design (will work but not optimized)

# Asset Screener

Next.js 14 financial dashboard for Hyperliquid perps + spot. Aggregates
real-time prices, multi-timeframe technical signals, Elfa social
intelligence, and HYPE TWAP buy-pressure into a Bracket-styled UI
with Telegram alerting on high-conviction setups.

**Live deployment:** [assets.lekker.design](https://assets.lekker.design)
**Repo:** [github.com/larrythelobsterbot/asset_screener](https://github.com/larrythelobsterbot/asset_screener)

## Architecture (one-page tour)

```
Browser → Nginx (TLS) → PM2 (Node, port 3003) → Next.js 14 App Router
                                                     ├─ Hyperliquid REST + WS
                                                     ├─ Elfa AI REST (budget-gated)
                                                     ├─ Hypurrscan REST + WS
                                                     ├─ CoinGecko REST (fallback)
                                                     ├─ Telegram Bot API (outbound)
                                                     └─ SQLite (data/screener.db, WAL)
```

Single Node process. SQLite for persistence + cross-restart state.
In-memory TTL cache for hot reads, with stale-while-revalidate.

## Required env vars (`.env.local`, chmod 600, gitignored)

```bash
# Optional — alerts are disabled if either is unset
TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
TELEGRAM_CHAT_ID=<user/group chat id, integer>

# Optional — Elfa AI social intelligence (paid; 1000 req/day on free tier)
# Sign up at dev.elfa.ai
ELFA_API_KEY=elfak_<token>

# Optional — alerter threshold for HYPE TWAP 1h buy pressure (default $1M)
HYPE_PRESSURE_ALERT_THRESHOLD_USD=1000000

# Optional — Elfa daily soft cap (default 950 of 1000 hard limit)
ELFA_DAILY_SOFT_CAP=950

# Optional — Supabase persistence for signal_events (centralized track record)
NEXT_PUBLIC_SUPABASE_URL=<url>
SUPABASE_SERVICE_ROLE_KEY=<service role key>

# Optional — override SQLite location (default: ./data/screener.db)
SCREENER_DB_PATH=/abs/path/to/screener.db
```

Next.js loads `.env.local` automatically at `next start`. PM2 reload
with `--update-env` after editing.

## Local development

```bash
npm install
npm run dev           # http://localhost:3000 (note: prod runs on 3003)
npm test              # node --test, no external deps
npm run lint
npm run build         # production build, required before pm2 reload
```

Node 22+ required (we use the global `WebSocket` API). Tested on 24.

## Production (PM2)

```bash
pm2 start ecosystem.config.js     # starts `asset-screener` on port 3003
pm2 reload asset-screener --update-env   # after code or env change
pm2 logs asset-screener --lines 50 --nostream
```

`ecosystem.config.js` pins memory at 512 MB and uses exponential
back-off restarts. The Next.js binary is invoked directly (not via
`npm start`) so PM2's version column reflects `package.json`.

Nginx terminates TLS and proxies port 443 → 3003 with the standard
upgrade headers for the HL WebSocket.

## Where things live

| Path | Purpose |
|---|---|
| `src/app/page.tsx` | Home — top bar, view toggle, filter pipeline |
| `src/app/layout.tsx` | Root layout, font loading |
| `src/app/globals.css` | Bracket design tokens + helpers |
| `src/app/api/markets/route.ts` | HL perp + spot + builder DEX + CoinGecko merge |
| `src/app/api/signals/route.ts` | Multi-TF scan, sector RS, social spike, alerter |
| `src/app/api/screener/route.ts` | Batch indicator stats per symbol |
| `src/app/api/asset/[symbol]/route.ts` | Per-symbol detail (input-validated) |
| `src/app/api/macro/route.ts` | Macro indicator strip |
| `src/app/api/social/trending/route.ts` | Elfa mindshare (1h cache) |
| `src/app/api/hype/pressure/route.ts` | HYPE TWAP buy-pressure (90s poll) |
| `src/lib/db.ts` | SQLite DAL + migrations (v5 currently) |
| `src/lib/cache.ts` | In-memory TTL + SWR with single-flight |
| `src/lib/fetchWithTimeout.ts` | Bounded outbound HTTP for all integrations |
| `src/lib/hyperliquid.ts` | REST client + token-bucket rate limiter |
| `src/lib/hyperliquidWs.ts` | WS client for live mids |
| `src/lib/hypurrscan.ts` | TWAP fetch + pressure formula (perp + spot) |
| `src/lib/elfa.ts` | Budget-aware client, atomic credit reservation |
| `src/lib/telegram.ts` | Outbound bot API |
| `src/lib/alerter.ts` | Conviction-scored Telegram dispatch w/ retry cooldown |
| `src/lib/signals.ts` | Signal taxonomy, detection, conviction scoring |
| `src/lib/indicators.ts` | Hand-rolled SMA/EMA/RSI/MACD/ATR/divergence |
| `src/components/*.tsx` | Bracket UI — table, heatmap treemap, side panel |
| `src/config/sectors.ts` | HL sector mappings, holdings, descriptions |

## SQLite schema (v5)

| Table | Purpose | Retention |
|---|---|---|
| `price_snapshots` | Per-symbol price/funding/OI time series, 30s cadence | 30d |
| `candles_cache` | Candle history (1h/4h/1d) | 30d / 90d / 365d |
| `event_history` | Signal de-bouncer state per (symbol, type, tf) | until next fire |
| `social_snapshots` | Elfa mindshare per (symbol, tf) | 30d |
| `hype_pressure_snapshots` | TWAP buy-pressure time series, 90s cadence | 30d |
| `runtime_kv` | Cooldowns + Elfa daily counters + misc kv | indefinite |

Daily prune job runs at startup + every 24h. WAL mode; reads
non-blocking with writes.

## Telegram setup

1. `@BotFather` → `/newbot` → copy token
2. Set `TELEGRAM_BOT_TOKEN` in `.env.local`
3. Open the bot in Telegram, send `/start` (Telegram bots can't
   initiate conversations)
4. `npx tsx scripts/telegram-bootstrap.ts` to discover your chat id
5. Set `TELEGRAM_CHAT_ID` in `.env.local`
6. `pm2 reload asset-screener --update-env`

Alerts fire when `scoreConviction(signals).label` is `Strong Buy` or
`Strong Sell` AND volatility regime is not `quiet`. Per (symbol,
direction) cooldown of 4h, with 5min retry on Telegram delivery failure.

## HYPE TWAP alert

Polls hypurrscan.io's `/twap/*` every 90s, filters to HYPE perp + spot
(asset IDs 159 and 10107), pro-rates value into 1h and 24h forward
windows, fires a Telegram alert when 1h pressure crosses
`HYPE_PRESSURE_ALERT_THRESHOLD_USD`. 1h cooldown while above threshold.

## Elfa budget management

Free tier is 1000 req/day. The client reserves a credit atomically
before each metered call (SQLite UPDATE) and releases it on
auth-rejected or transport failures (Elfa charges for everything else
including 4xx/429). Soft cap defaults to 950 (50-credit headroom) so
we don't accidentally trip the hard limit.

`/api/social/trending` caches results for 1h per time window — at
most 24 credits/day per active window, leaving ~280 for ad-hoc lookups.

## Testing

```bash
npm test         # 45 tests, no external deps
```

Coverage:
- DAL round-trip (snapshots, candles, event history, social, kv)
- Schema migration v0→v5 (run on each test invocation against a tmp file)
- Signal logic (RSI/MACD/divergence, sector RS, social spike)
- Conviction composition + cross-TF de-bouncing
- TWAP pressure formula (perp + spot merge, future-start guard, etc.)
- Snapshot age-bound enforcement
- Bounded vs unbounded snapshot lookups

Tests use Node's built-in test runner via `tsx`. No Jest/Vitest.

## Operational notes

- **Cold start**: ~250ms Next.js boot; HL WS connects in 1–2s;
  first `/api/markets` hits SQLite if available, else HL REST.
- **Schema migrations are forward-only**. Bumping `VERSION` in
  `db.ts` and adding a `MIGRATION_V<n>` block is the only contract.
- **All outbound HTTP has a timeout**. Default 15s; HL/Telegram
  override to 10s because they should be fast.
- **PM2 ecosystem caps memory at 512 MB**. Adjust in
  `ecosystem.config.js` if persistence grows; typical steady state
  is ~140 MB.
- **The `.claude/worktrees/` directory** is local-only working area
  for Claude Code agents — already in `.gitignore`.

## Production checklist (first deploy)

```bash
# 1. Build
npm install
npm run build

# 2. Configure
cp .env.local.example .env.local    # if you have one; otherwise hand-write
chmod 600 .env.local
nano .env.local                      # set TELEGRAM_*, ELFA_API_KEY

# 3. Start
pm2 start ecosystem.config.js
pm2 save                             # remember across reboot

# 4. Verify
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3003/
pm2 logs asset-screener --lines 30 --nostream
```

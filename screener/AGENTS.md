# AGENTS.md — Asset Screener

Next.js 15 (App Router) Hyperliquid signal screener. Live at `asset.lekker.design`.

## Commands

```bash
npm run dev          # local dev server (hot reload)
npm run build        # production build
npm start            # serve production build on :3003
npm run lint         # ESLint (zero warnings)
npm test             # node --test via tsx on src/lib/__tests__/*.test.ts
```

## Run / deploy (production)

Managed by PM2, NOT `npm start` directly:

```bash
pm2 start ecosystem.config.js     # name: asset-screener, port 3003, 512M cap
pm2 restart asset-screener        # after a build
pm2 logs asset-screener           # tail logs
```

Deploy = `npm run build` then `pm2 restart asset-screener`. nginx fronts it at `asset.lekker.design`.

## Layout

```
src/app/         App Router pages (incl. /journal, /api routes)
src/components/  React components
src/lib/         Core logic — signal calc, data access
src/lib/__tests__/  Tests (this is the ONLY tested dir)
src/config/      Config + constants
data/            Local SQLite + datasets
scripts/         One-off + cron scripts
```

## Stack & data

- **better-sqlite3** for local data (synchronous, fast). The DB lives under `data/`.
- **@supabase/supabase-js** for remote/persistent data.
- Tailwind + TypeScript throughout.

## Conventions

- App Router only — no `pages/` directory.
- Tests live in `src/lib/__tests__/` and run under `node --test` + `tsx`. Put new pure-logic tests there; UI is not unit-tested.
- The PM2 config runs the `next` binary directly (not `npm start`) so `pm2 list` shows the real package version. Don't change that back to `npm start`.
- Keep the production port at **3003** — nginx + PM2 both assume it.

## When Atlas works here

- **Never modify signal calculation logic or thresholds in `src/lib/` without explicit
  approval** — this is live trading-decision support; a silent logic change is worse
  than a crash.
- UI/component/styling changes: fine autonomously, but verify (below) before done.
- `data/*.sqlite` holds accumulated market history — treat as append-only; never
  regenerate or truncate without approval.

## Hermes delegation policy

- The primary brain/orchestrator is `gpt-5.6-sol` with `xhigh` reasoning.
- Delegated leaf executors use `gpt-5.6-luna` with `medium` reasoning through the
  `openai-codex` provider. Keep delegation flat (`max_spawn_depth: 1`) with at most
  three concurrent children.
- The primary agent owns architecture, decomposition, safety decisions, coordination,
  review, and final verification. Delegate bounded implementation, code inspection,
  testing, and research tasks when parallel work is useful.
- Give every child exact paths, constraints, acceptance criteria, relevant rules from
  this file, and verification commands. Children have no parent-conversation context.
- Treat child summaries as unverified. The primary agent must inspect changed files and
  run the relevant tests/build before reporting success.
- Never delegate approval decisions or bypass the trading-logic and data-safety rules
  above. Subagents cannot ask the user for clarification.

## Verify (after any change)

```bash
npm test 2>&1 | tail -5                          # lib tests pass
npm run build 2>&1 | tail -3                     # prod build clean
pm2 restart asset-screener && sleep 3
curl -s -o /dev/null -w "app HTTP %{http_code}\n" http://localhost:3003/
pm2 logs asset-screener --lines 10 --nostream    # no boot errors
```

## Gotchas

- **OI is denominated in COINS, not USD.** USD OI = `openInterest × price`, and the
  two factors must come from the same instant. Use `snapshotFullAtBounded` (not
  `snapshotAtBounded` + a separate OI read) for historical OI.
- **A few markets are quoted fractionally.** HL's SPX trades at index/20000. Prices
  are scaled up for display, so any `coin_quantity × price` must divide the scale
  back out via `rawPriceOf()` (`lib/hyperliquid.ts`), and a raw price must never be
  compared against a stored one — `price_snapshots` holds the SCALED mark, while
  `candles_cache` holds HL's RAW quote. Getting this wrong reported SPX at $54.2B
  of OI (real: $2.71M) and would report a -99.99% price delta. `PRICE_DISPLAY_SCALE`
  is the single source for this; don't reintroduce inline literals.
- **HIP-3 candles need the dex-prefixed coin.** `candleSnapshot` returns `null` for
  a bare `SKHX` *and* for the wrong dex (`km:SKHX`); only `xyz:SKHX` resolves. Fetch
  under the prefixed coin, cache under the bare ticker (`getCandles`' `cacheSymbol`).
- **Never write a per-row correlated subquery against `price_snapshots`** (13.7M rows
  and growing). Bound the ts range so SQLite can seek `idx_snap_sym_ts` and loop
  per-symbol instead — that's a ~1600x difference (7.3s → 4.5ms), and since
  `better-sqlite3` is synchronous, a slow query blocks every in-flight request.
  Measure new snapshot queries against the real DB before shipping.
- `better-sqlite3` is a native module — if Node version changes, run `npm rebuild better-sqlite3`.
- After any code change, the running PM2 process serves the OLD build until you `npm run build && pm2 restart asset-screener`.
- Don't commit `data/*.sqlite` or `.env.local` (Supabase keys).

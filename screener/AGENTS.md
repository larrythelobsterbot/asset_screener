# AGENTS.md — Asset Screener

Next.js 14 (App Router) Hyperliquid signal screener. Live at `assets.lekker.design`.

## Commands

```bash
npm run dev          # local dev server (hot reload)
npm run build        # production build
npm start            # serve production build on :3003
npm run lint         # next lint
npm test             # node --test via tsx on src/lib/__tests__/*.test.ts
```

## Run / deploy (production)

Managed by PM2, NOT `npm start` directly:

```bash
pm2 start ecosystem.config.js     # name: asset-screener, port 3003, 512M cap
pm2 restart asset-screener        # after a build
pm2 logs asset-screener           # tail logs
```

Deploy = `npm run build` then `pm2 restart asset-screener`. nginx fronts it at `assets.lekker.design`.

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

## Verify (after any change)

```bash
npm test 2>&1 | tail -5                          # lib tests pass
npm run build 2>&1 | tail -3                     # prod build clean
pm2 restart asset-screener && sleep 3
curl -s -o /dev/null -w "app HTTP %{http_code}\n" http://localhost:3003/
pm2 logs asset-screener --lines 10 --nostream    # no boot errors
```

## Gotchas

- `better-sqlite3` is a native module — if Node version changes, run `npm rebuild better-sqlite3`.
- After any code change, the running PM2 process serves the OLD build until you `npm run build && pm2 restart asset-screener`.
- Don't commit `data/*.sqlite` or `.env.local` (Supabase keys).

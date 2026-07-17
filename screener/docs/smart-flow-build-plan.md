# Build Plan: Smart-Money Flow — Phase 1 (Wallet Cohorts)

**Goal:** track a curated cohort of consistently-profitable Hyperliquid wallets and aggregate their positioning into per-coin **smart OI** — net long/short USD notional of the sharp subset, with 1h/24h deltas — surfaced next to the total-OI flow metrics shipped in the flow-metrics plan. The product is the **divergence read**: "crowd OI adding shorts, profitable cohort adding longs" (and its inverse) as an overlay on the owner's mean-reversion entries.

Owner-approved 2026-07-17 (Phase 1 only). **Phase 2 — holding-period classification, per-wallet pages, and any alerting — is NOT approved by this document.** Alerting on smart flow additionally requires the validation report (Task 6) to show signal first.

**Explicitly out of scope, do not build:** copy-trading of any kind; anything that touches `/api/signals`, `maybeDispatchAlerts`, or the Telegram path; auto-following individual wallets.

---

## Ground rules

All of screener/AGENTS.md applies. The ones people break, plus new ones from this plan's own probes:

1. **NEVER run `npm run dev` / `next dev` in this checkout.** Build only to deploy; then `pm2 restart asset-screener`.
2. **Measure every new SQLite query against the real DB before shipping.** The flow-metrics build found a "cheap" query pattern was 1600× off (20–40s route latency in prod). Bounded index seeks per symbol; no correlated subqueries over big tables; `better-sqlite3` is synchronous and blocks every in-flight request.
3. **The leaderboard host is UNOFFICIAL** (`stats-data.hyperliquid.xyz`). It can vanish or change shape any day. Ingest must validate shape defensively, keep the last-good cohort in SQLite, and degrade to "stale cohort" — never crash, never empty the cohort because one fetch failed. (Same failure-mode lesson as `getBuilderUniverse`: a transient fetch failure must not produce destructive state.)
4. **Leaderboard numbers are STALE.** Verified 2026-07-17: the top eligibility-ranked wallet showed $0.4M account value on the leaderboard and **$0.00 live** — drained. Cohort selection MUST re-validate liveness via `clearinghouseState` before a wallet is tracked.
5. **The leaderboard payload is 32MB / ~40.5k rows.** Do NOT fetch/parse it inside the main app process — the PM2 memory cap is 512M and a 32MB JSON parse briefly inflates far beyond its wire size. Ingest runs as a separate short-lived process (Task 2).
6. **Positions come with `positionValue` already in USD — use it.** Never compute `szi × displayPrice` yourself; that's the exact coin-vs-display-unit trap that shipped SPX at $54.2B OI (see AGENTS.md gotchas and `rawPriceOf()` if you ever genuinely need the multiplication).
7. Wallet addresses are public on-chain data; showing truncated addresses in the UI is fine. No doxxing features (no name-guessing, no cross-chain identity linking).

## Verified API facts (probed 2026-07-17)

- **Leaderboard:** `GET https://stats-data.hyperliquid.xyz/Mainnet/leaderboard` → `{leaderboardRows: [{ethAddress, accountValue, windowPerformances: [["day"|"week"|"month"|"allTime", {pnl, roi, vlm}], ...], prize, displayName}]}`. 40,508 rows, 32MB. All numerics are strings.
- **Positions:** `POST https://api.hyperliquid.xyz/info` `{"type":"clearinghouseState","user":"0x..."}` → `{marginSummary: {accountValue, totalNtlPos, ...}, assetPositions: [{position: {coin, szi, entryPx, positionValue, unrealizedPnl, leverage: {type, value}, marginUsed, ...}, type}], time}`. `szi` is signed coin size (negative = short); `positionValue` is unsigned USD notional. A wallet with no positions returns `assetPositions: []` (verified against the HLP vault).
- **Cohort pool size:** with filters accountValue ≥ $250k AND week-PnL > 0 AND month-PnL > 0 AND month-volume/accountValue < 50 (MM screen), the pool is ~938 wallets — comfortably enough to pick 300.
- **Rate budget:** all calls go through the existing token bucket in `lib/hyperliquid.ts` (10 req/s self-cap). 300 wallets × 1 call each per 15-min cycle, paced at 300ms spacing (the `hip3CandleWarmer` pattern) ≈ 90s per sweep, ~0.35 req/s sustained. Negligible.

## Task 1 — Schema (MIGRATION_V11) + DAL

**File:** `src/lib/db.ts` (+ `src/lib/__tests__/smart-flow.test.ts`, temp DB via `db-test-setup` import — first import, see existing tests)

```sql
-- V11
create table if not exists wallet_registry (
  address        text primary key,
  cohort         text not null,          -- 'sharp' | 'whale'
  account_value  real,                   -- LIVE value from validation, not leaderboard
  pnl_week       real, pnl_month real, roi_month real,
  turnover_month real,                   -- vlm_month / account_value (MM screen input)
  is_tracked     integer not null default 1,
  first_seen     integer not null, last_validated integer not null
);
create table if not exists wallet_positions (
  address  text not null,  ts integer not null,
  coin     text not null,
  szi      real not null,                -- signed, coins
  entry_px real,  position_value real,   -- USD, unsigned (HL's own figure)
  unrealized_pnl real,  leverage real,
  account_value  real                    -- marginSummary at snapshot time
);
create index if not exists idx_wpos_coin_ts on wallet_positions(coin, ts);
create index if not exists idx_wpos_addr_ts on wallet_positions(address, ts);
```

DAL (copy existing patterns exactly): `upsertWalletRegistry(rows[])` (txn), `trackedWallets()`, `insertWalletPositions(rows[])` (txn, like `insertPriceSnapshots`), `smartFlowAt(targetTs, maxAgeMs)` — **bounded seek** per coin: for each coin, the per-address newest row in `[target−maxAge, target]`, summed into `{coin → {longUsd, shortUsd, netUsd, wallets}}`. Long/short split by sign of `szi`; magnitude from `position_value`. `pruneWalletPositions(30d)` wired into the existing `startPruneJob` cycle.

Volume math (documented in a comment): 300 wallets × 96 snapshots/day × ~4 positions ≈ 115k rows/day, ~3.5M rows at 30-day retention — a quarter of `price_snapshots`. Benchmark `smartFlowAt` on synthetic data at that scale in the test; it must stay <50ms.

**Acceptance:** `npm test` green, including a test proving `smartFlowAt` pairs each wallet's szi/position_value from the SAME row (no cross-timestamp mixing — same invariant as `snapshotFullAtBounded`).

## Task 2 — Leaderboard ingest + cohort selection (separate process)

**Files:** `scripts/ingest-leaderboard.mjs`, one new entry in `ecosystem.config.js` (`autorestart: false`, `cron_restart: "20 0 * * *"` — runs once daily, exits; do NOT touch the main app's entry)

Flow: fetch leaderboard (30s timeout) → validate shape (bail loudly, keep last cohort) → filter eligibility: live-window data present, `accountValue ≥ 250_000`, `pnl.week > 0 AND pnl.month > 0`, `roi.month ≥ 0.02`, `turnover_month < 50` (MM screen), `displayName` not matching known vault patterns → score by consistency (rank = normalized month-ROI + week-ROI, NOT raw PnL — raw PnL selects lottery winners) → take top 300 as `sharp`; separately tag `accountValue ≥ $10M` wallets meeting a looser bar (month-PnL > 0) as `whale`, cap 100 → **liveness validation**: `clearinghouseState` each candidate (paced 300ms), drop any with live `accountValue < 100_000` (see ground rule 4) → upsert registry, set `is_tracked=0` for wallets that fell out (history stays).

The script opens the SAME SQLite file (WAL mode supports the second process — this is the documented multi-process pattern in db.ts's header comment). It must `process.exit(0)` when done.

**Acceptance:** run it once manually (`node scripts/ingest-leaderboard.mjs`); `select cohort, count(*) from wallet_registry group by cohort` shows ~300 sharp + up to 100 whale; a second run is idempotent; kill the network mid-run and confirm the previous cohort survives untouched.

## Task 3 — Position poller (in-app, warmer pattern)

**File:** `src/lib/walletPoller.ts`, booted from the markets route alongside `startHip3CandleWarmer()` (same idempotent-init comment style)

Every 15 min (first run 90s after boot): `trackedWallets()` → for each, `clearinghouseState` through the shared limiter with 300ms spacing → collect `wallet_positions` rows (one per open position; a wallet with zero positions still writes ONE row with `coin=''`, szi=0 — so "cohort went flat" is distinguishable from "poller didn't run") → single-txn insert. Re-entrancy guard + per-wallet try/catch + one summary log line (`[wallet-poller] 297 ok, 3 failed, 1123 positions, 91s`). A wallet erroring 5 cycles straight gets `is_tracked=0` (dead account) — logged.

The clearinghouseState caller belongs in `lib/hyperliquid.ts` (`getClearinghouseState(user)`, no caching — every call is a distinct user).

**Acceptance:** after two cycles, `select count(distinct address) from wallet_positions` ≈ tracked count; pm2 logs show the summary line; `/api/markets` cache-miss latency unchanged (the poller must not measurably block — check while a sweep is running).

## Task 4 — `/api/smart-flow` route

**File:** `src/app/api/smart-flow/route.ts`

Response per coin (only coins where cohort exposure > $50k): `{coin, longUsd, shortUsd, netUsd, wallets, netDelta1h, netDelta24h, crowdOiDelta24hPct (joined from the markets flow metrics via its cache), diverging: boolean}` — `diverging` = sign(smart netDelta24h) ≠ sign(crowd oiChange24hPct) AND |smart netDelta24h| > $250k. Deltas come from `smartFlowAt(now−1h, ±10min)` / `smartFlowAt(now−24h, ±2h)` — same-row pairing, staleness-bounded, nulls when the poller history is too young (cold start renders "warming up", not zeros). Cache 60s, stale-on-error, `no-store` headers — copy the derivs route shape.

**Acceptance:** `curl /api/smart-flow` returns rows with sane magnitudes (spot-check one wallet's position on hyperdash/hypurrscan against our stored row); nulls (not 0) for deltas during the first hour of data.

## Task 5 — Terminal panel

**File:** `src/components/SmartFlowPanel.tsx`, mounted on `/terminal` beside the derivs radar. Minimal phase-1 UI — no screener-table column yet.

Rows: coin, net bias bar (long vs short USD), Δ24h signed-compact USD, wallet count, and a ⚡ divergence marker when `diverging` (tooltip: "smart cohort net-added longs while total OI added shorts", with both numbers). Sort: |netDelta24h| desc. Reuse the radar's visual language; formatters — note the audit found six duplicate USD formatters, don't add a seventh: if `src/lib/format.ts` doesn't exist yet (pending refactor task), import from ScreenerTable's or copy ONE with a `// TODO(format.ts)` marker.

**Acceptance:** playwright screenshot of /terminal shows the panel with live rows; no console/hydration errors; SSE stream still works.

## Task 6 — Validation report (gate for any future alerting)

**File:** `scripts/smart-flow-report.mjs` (manual run, read-only)

After ≥7 days of poller data: for each day and each coin with |smart netDelta24h| > $250k, record cohort direction vs the NEXT 24h price change (from `price_snapshots`). Output a plain-text hit-rate table: smart-flow-follows vs smart-flow-fades, divergence days vs agreement days, per sector. No thresholds tuned, no conclusions embedded — the owner reads it and decides whether Phase 2 alerting is worth building. **This report existing and being run is a precondition for any alert work.**

## Sequencing

```
Task 1 (schema/DAL) → Task 2 (ingest) → Task 3 (poller) → Task 4 (API) → Task 5 (UI)
                                                     └→ (7+ days of data) → Task 6 (report)
```

Commit per task, conventional style. Verify checklist from AGENTS.md after every task, plus: `pm2 logs` must show poller/ingest summary lines and zero unhandled-rejection noise.

## Phase 2 (NOT approved — listed so nobody builds them "while in there")

Holding-period classification via `userFillsByTime` (short-term vs long-term sub-cohorts); per-wallet detail pages; smart-flow columns in the main screener table; any alerting (requires Task 6 report + explicit owner approval, and lives OUTSIDE `/api/signals` until approved).

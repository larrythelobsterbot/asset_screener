# Build Plan: Flow Metrics for the Asset Screener

> **STATUS — ALL tasks (1–4, 5A, 5B) are BUILT, verified and deployed (2026-07-14).**
> 5B was approved by the owner and shipped. Keep the rest of this document as the
> record of intent; the corrections below are what the build actually found, and
> matter more than the plan where they disagree.
>
> **5B's "alerting stays OFF behind a flag" was satisfied without a flag.** Every
> path to Telegram was traced first: `maybeDispatchAlerts` has exactly one caller
> (`/api/signals`), whose universe is `meta.universe` (NATIVE perps) filtered
> through `HL_PERP_SECTOR_MAP` — builder tickers are not in `meta.universe` at
> all — and `/api/screener` is consumed only by client components. A flag would
> have gated nothing. `sectors.test.ts` pins the real invariant instead: builder-
> only tickers must stay disjoint from the native sector map, so mapping one
> natively becomes a deliberate, test-breaking decision. **If you ever want HIP-3
> alerting, that is a change to `/api/signals`, not a flag flip here.**
>
> Four of this plan's assumptions were wrong. If you are planning follow-on
> work, start from these, not from the prose further down:
>
> 1. **"These queries are cheap" was wrong by ~1600x.** `snapshotAtBounded` ran a
>    correlated subquery over 13.7M rows (~7.3s), 5x per scan cycle — `/api/markets`
>    was taking **20–40s per cache miss in production** before this work, and adding
>    the planned queries would have made it worse. Fixed by bounding the range so
>    SQLite can seek the index (~4.5ms). Cache-miss is now ~0.6s. **Measure before
>    assuming a snapshot query is cheap; `better-sqlite3` is synchronous, so a slow
>    one blocks every request in flight.**
> 2. **"No special handling needed for SPX" was wrong.** OI is coin-denominated, so
>    `openInterest × displayPrice` inherited SPX's 20000x display scale and reported
>    **$54.2B of OI against $2.3M of volume** (real: $2.71M). See `PRICE_DISPLAY_SCALE`
>    in `lib/hyperliquid.ts` — it is now the single mechanism for that quirk, and
>    every coin×price multiplication must go through `rawPriceOf()`.
> 3. **"Equity/commodity candles have weekend gaps" was wrong.** HL's HIP-3 equity
>    perps trade 24/7 with no gaps (verified), so 7 bars really is 7 calendar days
>    and the 7D column means the same thing for every market. The plan's "acceptable
>    drift" caveat was unnecessary — but the check was not.
> 4. **"min bars ≥ 30 is the only gate that matters" understated it.** The HIP-3
>    listings are young — SKHX first traded 2026-02-19 (146 bars), NVDA 245,
>    XYZ100 275 — so `ma300` is null across the whole board and `ema200` resolves
>    only where history reaches it. The warmer fetches 300 bars (not 60) so
>    `ath_pct` isn't computed over a shallower window for HIP-3 than for crypto,
>    which would have made one column mean two different things. **Any new
>    indicator with a long lookback needs to expect nulls on HIP-3 for months.**
>
> Known nuance, not a defect: the candle path measures 7d from the bar close
> (23:59 UTC) while the snapshot fallback measures from the exact 7×24h mark.
> They differ by up to ~4pp on a fast-moving market (oil), <1pp on a calm one.
> Crypto has always used the candle path; HIP-3 now shares it. If you'd rather
> 7D% meant a true rolling 7×24h everywhere, that's a deliberate change to
> crypto's long-standing semantics and needs its own approval.

**Goal:** turn the screener's existing *state* views (current OI, current funding) into *flow* views (OI change, time-averaged funding, turnover, positioning regimes for every market including HIP-3 builder perps). All raw data already exists in `data/screener.db` → `price_snapshots` (minute-cadence mark/OI/funding for all ~320 HL + builder-dex markets, 30-day retention). **No new external data collection is required for Tasks 1–4.** Task 5 adds HL candle fetches for HIP-3 symbols.

Owner-approved on 2026-07-14. This document IS the approval for the `src/lib/` changes it specifies — but ONLY those. Do not change any other signal logic or thresholds (see AGENTS.md).

---

## Ground rules — read before touching anything

1. **NEVER run `npm run dev` / `next dev` in this checkout.** The live site is served by PM2 out of this directory's `.next/`. `next dev` clobbers it and breaks production (it happened on 2026-06-02). Run `npm run build` ONLY when you intend to deploy, and immediately follow with `pm2 restart asset-screener`.
2. `data/*.sqlite` is append-only accumulated history. Never truncate, regenerate, or write to it outside the existing `db.ts` helpers. For tests, point at a temp DB via the `SCREENER_DB_PATH` env var — never at the real one.
3. Do not modify `classifyRegime` thresholds (in `src/lib/coinalyzePoller.ts`) or `detectSignals` (in `src/lib/signals.ts`). You may *call* them with new inputs; you may not change their logic.
4. Tests live in `src/lib/__tests__/*.test.ts`, run with `npm test` (`node --test` via tsx). New pure logic gets a test. UI is not unit-tested.
5. All new `AssetData` / API fields must be **additive and nullable** — the UI already handles `null` gracefully (see how `change7d` rolled out), and downstream consumers (terminal page, Telegram alerter) must not break.
6. Work task-by-task, in order. Each task ends with the Verify checklist (bottom of this doc) passing. Commit per task, conventional-commit style (`feat(flow): ...`), matching repo history.

## Architecture primer (facts you need, verified 2026-07-14)

- `price_snapshots` schema (`src/lib/db.ts`, MIGRATION_V1): `(symbol, ts, mark, prev_day, funding, oi, volume)`, indexes `idx_snap_sym_ts(symbol, ts desc)` and `idx_snap_ts(ts)`. One row per symbol per markets scan (~60s cadence via the instrumentation keepalive). 30-day retention via `prunePriceSnapshots`.
- **`oi` is denominated in COINS, not USD.** USD OI at time T = `oi(T) × mark(T)`. Always pair oi with the mark *from the same row*.
- **`funding` is the hourly rate as a decimal** (e.g. `0.0000125`). APR = `funding × 24 × 365`. It whipsaws hard on HIP-3 markets (SKHX swung +454% → −215% APR within an hour on 2026-07-14) — that's the motivation for Task 2's time-averaged funding.
- **SPX is special-cased**: HL quotes it as index/20000. `src/app/api/markets/route.ts` scales price ×20000 before snapshotting, so `price_snapshots` rows for SPX are *scaled* (correct), but `candles_cache` rows for SPX would be *unscaled* (raw HL). The markets route already skips the candle path for SPX; preserve that in anything you build.
- Builder-dex (HIP-3) symbols are snapshotted under their **bare ticker** (`SKHX`, not `km:SKHX`) — the dex prefix is stripped in the markets route, with dedup precedence: native HL market wins over builder dexes; among dexes, earlier entry in `BUILDER_DEXES` (in `src/config/sectors.ts`) wins.
- Existing helpers you'll reuse (all in `src/lib/db.ts`): `snapshotAt` / `snapshotAtBounded` (point-in-time lookup, mark only), `snapshotSeriesBulk` (time series since a timestamp), `getCandlesBulkFromCache`.
- `/api/markets` caches its response 30s (`cache.set("api:markets", assets, 30_000)`); `/api/derivs` caches 20s. Anything you add inside those routes runs at that cadence — keep per-scan SQLite work in the low tens of milliseconds.

---

## Task 1 — DB helpers (foundation; everything else depends on this)

**File:** `src/lib/db.ts` (+ new test file `src/lib/__tests__/flow-helpers.test.ts`)

### 1a. `snapshotFullAtBounded`

`snapshotAtBounded` returns only `mark`. OI deltas need `oi` (and Task 2 wants `funding`) from the same row. Add:

```ts
export interface SnapshotPointFull { mark: number; oi: number | null; funding: number | null; ts: number }

export function snapshotFullAtBounded(
  targetTs: number,
  maxAgeMs: number,
  symbols?: string[],
): Map<string, SnapshotPointFull>
```

Implementation: copy the correlated-subquery pattern from `snapshotAt` (greatest `ts <= targetTs` per symbol — it's served by `idx_snap_sym_ts`), but `select p.symbol, p.mark, p.oi, p.funding, p.ts`. Apply the same `|targetTs − ts| <= maxAgeMs` filter as `snapshotAtBounded`. Do **not** refactor `snapshotAt` itself — leave existing callers untouched.

### 1b. `avgFundingSince`

```ts
export function avgFundingSince(sinceTs: number, symbols?: string[]): Map<string, number>
```

SQL: `select symbol, avg(funding) as f from price_snapshots where ts >= ? and funding is not null group by symbol` (+ `symbol in (...)` when `symbols` given). A 24h window is ~460k rows across 320 symbols; measure it once with `console.time`. If it exceeds ~50ms, cache the result in `src/lib/cache.ts`'s in-memory cache under `"flow:avgFunding24h"` with a 120s TTL (funding averages move slowly; a 2-min-stale average is fine).

### Tests (1 file, pure logic against a temp DB)

Set `process.env.SCREENER_DB_PATH` to a file under `os.tmpdir()` *before* importing `db.ts`. Seed a handful of `insertPriceSnapshots` rows and assert:
- `snapshotFullAtBounded` returns the nearest-before row within tolerance, with correct `oi`/`funding`; drops rows outside tolerance.
- `avgFundingSince` averages only rows ≥ sinceTs, ignores null funding, respects the symbols filter.

**Acceptance:** `npm test` green.

---

## Task 2 — Flow metrics in `/api/markets`

**Files:** `src/lib/types.ts`, `src/app/api/markets/route.ts`

Add to `AssetData` (all nullable, default null):

```ts
oiUsd: number | null;            // openInterest × price, computed server-side once
oiChange24hUsd: number | null;   // oiUsd(now) − oiUsd(24h ago)
oiChange24hPct: number | null;
oiChange7dUsd: number | null;
oiChange7dPct: number | null;
fundingAvg24h: number | null;    // mean hourly funding rate over 24h (decimal)
volOiRatio: number | null;       // volume24h / oiUsd — turnover
```

In the markets route's existing backfill section (where `snap1h`/`snap4h`/`snap7d` are computed), add:

```ts
const full24h = snapshotFullAtBounded(snapshotTs - 24 * 3_600_000, 2 * 3_600_000, hlSymbolsForBackfill);
const full7d  = snapshotFullAtBounded(snapshotTs - 7 * 86_400_000, 6 * 3_600_000, hlSymbolsForBackfill);
const avgFunding = avgFundingSince(snapshotTs - 24 * 3_600_000, hlSymbolsForBackfill);
```

Then per HL-sourced asset in the existing backfill loop: `oiUsd = openInterest × price` (null if either missing/0); prior USD OI = `prior.oi × prior.mark` (same-row pairing — never mix current price with prior oi); deltas only when prior USD OI > 0; `volOiRatio = volume24h / oiUsd` when `oiUsd > 0`. CoinGecko-sourced assets keep all fields null.

Notes:
- `full7d` can replace the Task-0-era `snap7d` mark lookup (its `mark` field serves the existing `change7d` fallback) — one query instead of two. Keep the change7d behavior byte-identical.
- SPX needs no special handling here: snapshots are consistently scaled.
- Keep the SPX candle-path exclusion that's already in the loop.

**Acceptance:**
```bash
curl -s localhost:3003/api/markets | python3 -c "
import json,sys; d=json.load(sys.stdin)
hl=[a for a in d if a['source']=='hyperliquid' and (a.get('volume24h') or 0)>1e6]
ok=[a for a in hl if a.get('oiChange24hPct') is not None and a.get('fundingAvg24h') is not None]
print(f'{len(ok)}/{len(hl)} active HL markets have flow metrics')  # expect >90%
spx=[a for a in d if a['symbol']=='SPX'][0]; print('SPX 7d sane:', -50 < (spx['change7d'] or 0) < 50)"
```
Plus: response time of `/api/markets` (cache-miss) not measurably worse — check `pm2 logs` for slow-scan warnings.

---

## Task 3 — UI columns

**Files:** `src/components/ScreenerTable.tsx`, `src/components/Heatmap.tsx` (read them first; follow existing column/formatting patterns exactly)

- ScreenerTable: add sortable columns **ΔOI 24h** (render `oiChange24hUsd` as signed compact USD, e.g. `+$41M`, green/red by sign, with `oiChange24hPct` as a small suffix like `+3.2%`), **ΔOI 7d** (same), **F̄ 24h** (render `fundingAvg24h` as APR %, i.e. `×24×365×100`, 1 decimal, sign-colored), **Vol/OI** (1 decimal, e.g. `2.5×`; dim when < 0.5). Null → the same em-dash treatment existing columns use.
- Heatmap: add ΔOI 24h and F̄ 24h APR to the hover tooltip only (no layout change).
- Default sort order and existing columns must not change.

**Acceptance:** visual check on `localhost:3003` after deploy — sort by ΔOI 24h ascending/descending works; nulls sort last; no hydration warnings in `pm2 logs`.

---

## Task 4 — Regime tags for the whole exchange (incl. HIP-3)

**File:** `src/lib/hlDerivs.ts` (and `src/app/api/derivs/route.ts` only if the response shape needs a version bump — it shouldn't; the change is additive)

Today `computeHlDerivs` covers only `meta.universe` (native perps) top-30 by volume. Extend it:

1. Fetch builder universes alongside native: `getBuilderDexData(dex)` for each of `BUILDER_DEXES` (import from `@/config/sectors`; see the markets route for usage, incl. `.catch(() => null)` per dex).
2. Merge into one candidate list with the **same dedup precedence as the markets route** (native wins; earlier dex wins), using **bare tickers** — that's how `price_snapshots` keys them, so `snapshotSeriesBulk` lookups just work.
3. Raise `TOP_N` from 30 to **100** (still by 24h notional volume, now across the merged list). Perf: `snapshotSeriesBulk` over a 1h window for 100 symbols ≈ 6k rows — trivial. Do not go wider without measuring; the route recomputes every 20s.
4. Add to `HlDerivsItem`: `dex: string | null` (null for native) and `sector: string | null` (look up via `HL_PERP_SECTOR_MAP` / `HL_BUILDER_PERP_MAP`). Additive only.
5. `classifyRegime` is called unchanged. Zero-volume/ghost listings: keep the existing `vol > 0` filter.

**Acceptance:**
```bash
curl -s localhost:3003/api/derivs | python3 -c "
import json,sys; items=json.load(sys.stdin)['items']
print(len(items), 'items')                       # expect ~100
print(sorted({i.get('sector') for i in items}))  # expect stocks/commodities/indices present
print([i['base'] for i in items if i.get('dex')][:5])"
```
Terminal page (`/terminal`) still renders its radar (it consumes this endpoint — check it after deploy).

---## Task 5 — HIP-3 candle warming + signals coverage (two phases; Phase B needs a separate go-ahead)

### Phase A — warm `candles_cache` for HIP-3 (no signal changes)

**Files:** `src/lib/hyperliquid.ts`, plus a small warmer loop (put it in `src/lib/instrumentation`-adjacent keepalive code — find where the `markets+feed+social @60s` keepalive is registered and add a slower cadence job there).

1. **Verify the API shape first** (read-only, safe): HL `candleSnapshot` for builder perps takes the dex-prefixed coin, e.g. `{"type":"candleSnapshot","req":{"coin":"km:SKHX","interval":"1d", ...}}`. Confirm with a one-off `curl` against `https://api.hyperliquid.xyz/info` before writing code. If it returns empty for prefixed coins, stop and report — don't guess.
2. Add an optional `cacheSymbol` param to `getCandles(coin, interval, count, cacheSymbol = coin)` — fetch under `coin` (prefixed), read/write `candles_cache` under `cacheSymbol` (bare ticker). This makes the markets route's existing `getCandlesBulkFromCache(hlSymbolsForBackfill, "1d", 10)` pick HIP-3 candles up **with zero further changes** — the snapshot fallback then naturally stops being used for those symbols.
3. Warmer job: every 6h, fetch `1d × 60 bars` for the top ~40 HIP-3 tickers by 24h volume (reuse the merged-universe helper from Task 4). That's ~40 calls per 6h against the existing 10 req/s limiter — negligible. **Exclude SPX** (scale mismatch documented above).
4. Equity/commodity markets have weekend/holiday gaps — bars are simply absent. That's fine for change7d (calendar lookback via snapshots stays the fallback when candles are short) but means "7 bars ago" ≠ "7 calendar days ago" for equities. Acceptable; note it in a code comment.

**Acceptance:** after one warmer cycle, `select count(*) from candles_cache where symbol='SKHX' and interval='1d'` > 0 (use a read-only better-sqlite3 one-liner), and `/api/markets` change7d for SKHX stays sane (within a few % of the snapshot-derived value from before).

### Phase B — HIP-3 in `/api/screener` (RSI/EMA/ATH%) — **do not build without explicit owner approval**

This extends the signal universe (currently 71 crypto symbols) and therefore what the Telegram alerter can fire on. Scope when approved: include top-N HIP-3 tickers in the `/api/screener` computation using cached 1d candles only (no 1h/4h), `min bars ≥ 30` guard already exists, and alerting for HIP-3 stays OFF behind a flag until separately enabled.

---

## Sequencing & dependencies

```
Task 1 (db helpers) ──► Task 2 (API fields) ──► Task 3 (UI)
                    └──► Task 4 (regimes, independent of 2/3)
Task 5A (candles) — independent, any time after Task 1
Task 5B — blocked on owner approval
```

## Verify checklist (run after EVERY task, before commit)

```bash
npm test 2>&1 | tail -5                          # green
npm run build 2>&1 | tail -3                     # clean — ONLY when deploying
pm2 restart asset-screener && sleep 3
curl -s -o /dev/null -w "app HTTP %{http_code}\n" http://localhost:3003/
pm2 logs asset-screener --lines 15 --nostream    # no boot errors, no slow-scan warnings
```

Plus the task's own acceptance check. If the build breaks production styling (unstyled page): `git stash -u && npm run build && pm2 restart asset-screener`, verify, then `git stash pop` and fix forward.

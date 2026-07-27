# Market-Open 4-Hour OI Briefings Implementation Plan

> **For Hermes:** Implement with strict RED→GREEN tracer bullets; do not commit, push, deploy, or enable Telegram delivery without explicit user approval.

**Goal:** Build durable, informational Telegram positioning briefings 30 minutes before the Tokyo, London, and New York cash opens using the prior four hours of Hyperliquid OI, price, funding, liquidity, and smart-wallet context.

**Architecture:** Pure domain functions derive and rank report items from same-row snapshots. A dedicated service reads bounded SQLite evidence, persists a report and its items transactionally before delivery, and records provider acknowledgement separately. A protected internal scheduler route is self-pinged by Next instrumentation; independent shadow-generation and Telegram-delivery flags are off by default, and the scheduler is timezone/DST-aware, exchange-holiday-aware, rate-limited, single-flight, and idempotent. A separate evaluator records open/+1h/+4h/+24h observations. Read-only scripts provide preview and historical cohort/control analysis.

**Tech stack:** TypeScript, Node test runner, Next.js route handlers/instrumentation, better-sqlite3, `Intl.DateTimeFormat`, existing Hyperliquid/cache/Telegram helpers.

---

## Product rules

- Informational/shadow-only; never alter `maybeDispatchAlerts`, Stage 2 policy, trade-card cooldowns, or trade-alert analytics.
- Sessions: Tokyo 09:00 JST, London 08:00 local, NYSE 09:30 local; report at T−30m.
- Skip weekends and reference-exchange holidays. Calendar coverage is explicit for 2026–2027 and visible in health; uncovered future years degrade visibly rather than silently claiming holiday accuracy.
- Four-hour prior and current OI/mark/funding must come from same SQLite rows within bounded freshness tolerances.
- `oi` is contract/coin OI. Rank by `abs((currentOi-priorOi) * priorRawPrice)`—the quantity effect—not total USD OI change.
- Show contract OI %, quantity-effect USD, total USD OI delta, price %, funding APR, quadrant, smart-flow delta/alignment, and snapshot age.
- Crypto sectors only: majors/l1/defi/meme/ai/gaming/infra/crypto-major/crypto-alt.
- Equity universe: stocks/pre-IPO/indices mapped to the relevant cash region; no commodities/FX.
- Top 5 per universe after configurable liquidity/materiality gates. Suppress when fewer than two total valid items.
- Rollout envs are independent and both default off: `MARKET_OPEN_OI_SHADOW_ENABLED=true` reserves report/item evidence without any Telegram attempt; only the separate `MARKET_OPEN_OI_ENABLED=true` delivery approval can call Telegram.
- Unknown Telegram acknowledgement remains unknown and is not automatically retried.

## Task 1 — Pure OI derivation and ranking

**Files**
- Create `src/lib/marketOpenOi.ts`
- Create `src/lib/__tests__/marketOpenOi.test.ts`

**TDD slices**
1. Test same-row four-hour derivation, scaled raw prices, contract OI %, quantity-effect USD, total USD OI delta, price %, and quadrant; verify RED, implement, verify GREEN.
2. Test invalid/missing/stale/negative OI rejection while preserving valid zero-current-OI unwind events; RED→GREEN.
3. Test sector/universe/region classification and commodities/FX exclusion; RED→GREEN.
4. Test minimum OI, volume, percentage, and USD materiality gates; RED→GREEN.
5. Test independent top-five crypto/equity ranking by absolute quantity-effect USD; RED→GREEN.
6. Test smart-flow context and conservative alignment semantics; RED→GREEN.

## Task 2 — Timezone, DST, weekday, holiday, and due-window logic

**Files**
- Create `src/lib/marketOpenOiCalendar.ts`
- Extend `src/lib/__tests__/marketOpenOi.test.ts`

**TDD slices**
1. Test Tokyo UTC conversion and prior-UTC-date report time.
2. Test London summer/winter DST conversion.
3. Test New York summer/winter DST conversion.
4. Test weekend and 2026/2027 exchange holiday suppression.
5. Test a bounded late-start grace window and stable `session:local-date` idempotency key.
6. Test explicit uncovered-year calendar warning.

## Task 3 — Telegram format

**Files**
- Extend `src/lib/marketOpenOi.ts`
- Extend `src/lib/__tests__/marketOpenOi.test.ts`

**TDD slices**
1. Test concise HTML-safe message with session/open/lookback/freshness.
2. Test separate crypto/equity blocks and all required metrics.
3. Test missing smart-flow/funding rendering, signed values, compact USD units, and Telegram length bound.
4. Test suppression under two valid items.

## Task 4 — Durable report, item, delivery, and outcome schema

**Files**
- Modify `src/lib/db.ts` (migration v23 and DAL)
- Extend `src/lib/__tests__/db.test.ts`

**Schema**
- `market_open_oi_reports`: immutable session identity/timestamps/config snapshot plus delivery state.
- `market_open_oi_items`: immutable ranked evidence and derived fields.
- `market_open_oi_outcomes`: idempotent `open`, `1h`, `4h`, `24h` observations.

**TDD slices**
1. Transactionally reserve report+items by unique key; duplicate reservation returns existing without sending.
2. Enforce shadow/pending/delivered/failed/unknown/expired invariants.
3. Mark confirmed Telegram acknowledgement with unique provider message id.
4. Mark definite rejection separately from uncertain acknowledgement.
5. List due outcome items and upsert each horizon exactly once.
6. Summarize delivery/outcome state for health without exposing provider IDs publicly.

## Task 5 — Service, delivery, and outcome evaluator

**Files**
- Create `src/lib/marketOpenOiService.ts`
- Create `src/lib/marketOpenOiScheduler.ts`
- Create `src/lib/__tests__/marketOpenOiService.test.ts`

**TDD slices**
1. Build report from latest and bounded four-hour SQLite snapshots.
2. Join 4h smart-wallet delta using the same current tracked-wallet cohort; null on insufficient history.
3. Persist before external send and transition acknowledgement correctly.
4. Do not reserve/send when disabled, not due, market closed, or insufficient sample; shadow mode may reserve evidence but never creates a Telegram attempt; delivery mode fails closed when Telegram is missing.
5. Coalesce concurrent scheduler kicks and enforce minimum interval.
6. Evaluate open/+1h/+4h/+24h from bounded pre-target snapshots; preserve missing evidence honestly.
7. Health distinguishes disabled/starting/healthy/stale/error and exposes last attempt/success separately.

## Task 6 — Protected runtime integration

**Files**
- Create `src/app/api/market-open-oi/run/route.ts`
- Modify `src/instrumentation.ts`
- Modify `src/app/api/health/route.ts`
- Add focused tests where route logic can be tested as pure guards.

**Steps**
1. Generate process-local capability at boot; POST every minute after a staggered warm-up.
2. Fail closed with 401 when capability is absent/wrong.
3. Keep route dynamic/no-store and never expose a public send path.
4. Add scheduler telemetry to health without token/chat/provider identifiers.

## Task 7 — Preview and historical analysis

**Files**
- Create `scripts/market-open-oi-report.ts`
- Create `scripts/market-open-oi-backtest.ts`
- Modify `package.json`

**Rules**
- Preview is read-only and never sends.
- Backtest is dry-run/read-only by default.
- Reconstruct historical report-time evidence with historical volume/funding; omit smart-flow from formal claims because current cohort membership would introduce survivorship bias.
- Evaluate open/+1h/+4h/+24h returns by session, universe, and quadrant.
- Compare selected cohorts with all eligible same-open assets and deterministic non-open windows; disclose truncation/missing evidence and suppress verdicts when samples are inadequate.

## Task 8 — Verification and review

1. Run focused RED/GREEN tests throughout.
2. Run full `npm test`, `npm run lint`, `npx tsc --noEmit`.
3. Rehearse v22→v23 migration on a copied production DB; verify schema/indexes and preserve source DB checksum.
4. Run preview and 14–30 day historical report read-only; inspect sample sizes/runtime.
5. Run `npm run build` only after tests/lint/typecheck.
6. Do not restart PM2 or deploy. Start a separate private preview on a non-production port/Tailscale binding if runtime verification needs a server.
7. Obtain independent spec-compliance and code-quality review; reproduce valid findings with failing tests before fixes.

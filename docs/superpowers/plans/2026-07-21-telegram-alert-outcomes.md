# Telegram Alert Outcomes Implementation Plan

> **For Hermes:** Use subagent-driven-development and strict RED→GREEN TDD. Do not commit or push; the user has not requested either.

**Goal:** Build an auditable Telegram-alert lifecycle that records delivery, evaluates TP/SL outcomes honestly, and exposes enough performance evidence to determine whether alerts have positive expectancy.

**Architecture:** Add an append-only SQLite `telegram_alerts` ledger (schema v13) separate from raw signal debounce state and the manual trade journal. The alerter writes a pending attempt before calling Telegram, then records Telegram acknowledgement/failure and makes delivered trade cards eligible for a minute-cadence evaluator. A pure evaluator grades long/short paths from post-alert one-minute snapshots plus cached 1h candle highs/lows, marks same-candle dual hits ambiguous, expires unresolved alerts after 48h, and never guesses through missing data. A read-only API and `/signals` dashboard report delivery, outcomes, expectancy, and evidence strength.

**Tech Stack:** Next.js 15 App Router, TypeScript, `better-sqlite3`, Node `node:test`, existing Hyperliquid snapshots/candle cache, PM2 instrumentation keepalive.

**Non-goals:** Do not alter signal detection, conviction weights, alert thresholds, stop/target sizing, authentication, Smart Flow behavior, or production dependency versions.

---

### Task 1: Add durable alert-ledger schema and DAL

**Objective:** Persist every Telegram send attempt and its lifecycle without touching accumulated market tables.

**Files:**
- Modify: `screener/src/lib/db.ts`
- Test: `screener/src/lib/__tests__/db.test.ts`

**Steps:**
1. Write failing DAL tests for pending insertion, delivered/failed transitions, message-ID idempotency, open-alert listing, outcome updates, summary/list reads, and migration-created indexes.
2. Run the focused DB tests and verify they fail because the APIs/table do not exist.
3. Add schema v13 with `telegram_alerts`: delivery fields, trade-card fields, signal snapshots, 48h expiry, outcome/evaluation fields, and indexes on delivery/outcome/time/symbol; unique partial index on Telegram message ID.
4. Add typed DAL functions using prepared statements and transactions where transitions must be atomic.
5. Run focused and full DB tests until green.

### Task 2: Build the pure TP/SL evaluator

**Objective:** Grade alerts deterministically without changing signal-generation logic.

**Files:**
- Create: `screener/src/lib/alertOutcomes.ts`
- Create: `screener/src/lib/__tests__/alertOutcomes.test.ts`

**Semantics:**
- Long: low ≤ stop is stop; high ≥ target is target. Short reverses comparisons.
- Use price snapshots after alert time to cover the remainder of the alert’s opening 1h candle.
- Use cached 1h OHLC candles beginning with the first full candle after the alert.
- If one candle reaches both boundaries, return `ambiguous`; never infer intrabar order.
- At expiry, mark `expired` using the freshest valid mark/close and compute mark-to-market R when possible.
- Missing or incomplete evidence remains `open`; missing trade-card levels are `untrackable`.
- Re-evaluation is idempotent and terminal outcomes never change.

**Steps:**
1. Add one failing test per vertical behavior: long target, long stop, short target, short stop, same-candle ambiguity, opening-partial snapshots, expiry, missing data, and idempotency.
2. Run each focused test to verify RED.
3. Implement the minimum pure evaluator and R calculation needed for GREEN.
4. Refactor shared boundary logic only after tests pass.

### Task 3: Persist delivery from the alerter

**Objective:** Connect Telegram API acknowledgements to durable trade-card records.

**Files:**
- Modify: `screener/src/lib/alerter.ts`
- Test: `screener/src/lib/__tests__/alerter.test.ts` or a new focused tracker test

**Steps:**
1. Write failing tests around a dependency-injected dispatch helper: pending record before send; delivered record with `message_id`; failed record with sanitized error; missing trade card becomes untrackable.
2. Verify RED.
3. Refactor alert preparation into a typed record payload without changing scoring, thresholds, cooldown, formatting, or trade-card math.
4. Insert pending immediately after cooldown claim, send Telegram, then transition to delivered/failed.
5. Preserve the existing retry cooldown rewind on failure.
6. Verify GREEN and existing alerter tests.

### Task 4: Add evaluator orchestration and health telemetry

**Objective:** Evaluate open alerts every minute without browser traffic, duplicate runs, or build-time side effects.

**Files:**
- Create: `screener/src/lib/alertOutcomeTracker.ts`
- Create: `screener/src/lib/__tests__/alertOutcomeTracker.test.ts` where pure orchestration can be tested
- Modify: `screener/src/app/api/signals/route.ts`
- Modify: `screener/src/app/api/health/route.ts`

**Steps:**
1. Write failing tests for single-flight/minimum-interval behavior and terminal update persistence.
2. Implement a non-blocking `kickAlertOutcomeEvaluation()` called from the already visitor-independent `/api/signals` keepalive path.
3. Group open alerts by symbol, bound every SQLite query by alert time/expiry, and use the scaled `price_snapshots` plus raw candle conventions correctly.
4. Track last run/success/duration/scanned/updated/errors and expose these in `/api/health`.
5. Do not start work at module import or during `next build`.

### Task 5: Add performance analytics API and UI

**Objective:** Show whether delivered alerts are promising, weak, or still statistically inconclusive.

**Files:**
- Create: `screener/src/lib/alertPerformance.ts`
- Create: `screener/src/lib/__tests__/alertPerformance.test.ts`
- Create: `screener/src/app/api/alert-performance/route.ts`
- Create: `screener/src/app/signals/page.tsx`
- Modify: `screener/src/app/page.tsx`
- Modify: `screener/src/app/journal/page.tsx`

**Steps:**
1. Write failing pure-summary tests for counts, target-vs-stop win rate, success rate across all terminal outcomes, expectancy R, and insufficient/inconclusive/promising/weak evidence labels.
2. Use a minimum target/stop sample before any verdict; compare a Wilson interval with the 25% pre-fee breakeven target rate for a 3R/-1R system.
3. Add a no-store API returning summary, conviction/family breakdowns, and recent alerts without exposing Telegram chat IDs or errors containing secrets.
4. Add an accessible responsive dashboard with explicit `open`, `target`, `stop`, `expired`, `ambiguous`, `untrackable`, and delivery-failure states.
5. Link it from the screener and journal.

### Task 6: Build safe historical backfill tooling

**Objective:** Recover old alerts only from an explicit Telegram Desktop JSON export; never infer trade cards from aggregate logs.

**Files:**
- Create: `screener/src/lib/telegramExport.ts`
- Create: `screener/src/lib/__tests__/telegramExport.test.ts`
- Create: `screener/scripts/backfill-telegram-alerts.ts`

**Steps:**
1. Write failing parser tests for Telegram JSON text strings/entity arrays and the current alert format.
2. Parse message ID, timestamp, symbol, direction, entry, stop, target, score, and label.
3. Default the script to dry-run; require `--apply` for inserts.
4. Make inserts idempotent on Telegram message ID and mark imported provenance.
5. Report skipped/unparseable messages. Do not run `--apply` until the user supplies an export.

### Task 7: Review, validate, deploy, and verify

**Objective:** Ship the complete loop safely to production.

**Steps:**
1. Run focused tests after every slice, then `npm run lint`, `npm test`, `npx tsc --noEmit`, `npm run build`, and `git diff --check`.
2. Independently review schema transitions, evaluator semantics, scaling conventions, public API exposure, UI accessibility, and timer lifecycle.
3. Measure evaluator queries against the real read-only database; reject unbounded scans.
4. Restart `asset-screener` via PM2 using the NVM Node path.
5. Verify `/api/health`, `/api/alert-performance`, `/signals`, `/api/signals`, homepage, existing journal, PM2 logs, and browser console.
6. Trigger no synthetic production Telegram alert. Verify persistence on the next naturally qualifying alert or through a test DB only.
7. Document the known residual nested PostCSS advisories; do not force-downgrade Next.js.

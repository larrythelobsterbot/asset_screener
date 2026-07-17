#!/usr/bin/env node
// Leaderboard ingest + cohort selection (smart-money flow, Task 2).
//
// Why a separate process: the leaderboard payload is ~32MB / ~40.5k rows.
// Parsing that inside the main Next.js process would briefly inflate well
// past the 512M PM2 memory cap (see docs/smart-flow-build-plan.md, ground
// rule 5). This script runs standalone (PM2 app "smart-flow-ingest",
// cron_restart, autorestart: false — see ecosystem.config.js), does its
// work, and exits.
//
// Failure posture (ground rule 3 — the leaderboard host is UNOFFICIAL,
// stats-data.hyperliquid.xyz, and can vanish or change shape any day):
// on ANY fetch or shape-validation failure this script logs one warning
// line and exits 0 WITHOUT touching wallet_registry. The last-good cohort
// simply survives untouched — same failure-mode lesson as
// getBuilderUniverse: a transient fetch failure must never produce
// destructive state.
//
// Liveness (ground rule 4): leaderboard numbers are stale. Verified
// 2026-07-17, the top eligibility-ranked wallet showed $0.4M on the
// leaderboard and $0.00 live (drained). Every selected wallet is
// re-validated via clearinghouseState before it's written as tracked.
//
// This is a plain Node ESM script (package.json has no "type": "module",
// hence the .mjs extension) and intentionally cannot import the TypeScript
// DAL in src/lib/db.ts. It re-implements the upsert against the identical
// schema instead.
//
// *** SYNC WARNING ***
// UPSERT_SQL below is copied verbatim from upsertWalletRegistry() in
// src/lib/db.ts. If that function's SQL or the wallet_registry schema
// (MIGRATION_V11) changes, update UPSERT_SQL here to match, by hand.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENER_DIR = path.join(SCRIPT_DIR, "..");
// Same resolution as src/lib/db.ts's getDb(), but anchored on the script's
// own location (not process.cwd()) so a cron-triggered run works no matter
// what directory PM2 launches it from.
const DB_PATH =
  process.env.SCREENER_DB_PATH ?? path.join(SCREENER_DIR, "data", "screener.db");

const LEADERBOARD_URL = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const LEADERBOARD_TIMEOUT_MS = 30_000;
const LIVENESS_TIMEOUT_MS = 10_000;
// No shared token bucket here (this is a standalone process, not the app's
// lib/hyperliquid.ts limiter) — 300ms spacing between clearinghouseState
// calls IS the rate limit. ~2 minutes for 400 wallets is fine for a
// once-daily cron job.
const LIVENESS_SPACING_MS = 300;

// Eligibility filters (MM screen), exactly per the build plan.
const MIN_ACCOUNT_VALUE = 250_000;
const MIN_ROI_MONTH = 0.02;
const MAX_TURNOVER_MONTH = 50;
const SHARP_CAP = 300;

const WHALE_MIN_ACCOUNT_VALUE = 10_000_000;
const WHALE_CAP = 100;

// Ground rule 4: drop any selected wallet whose LIVE accountValue has
// drained below this, regardless of what the (stale) leaderboard showed.
const LIVENESS_MIN_ACCOUNT_VALUE = 100_000;

const VAULT_NAME_RE = /vault|hlp|treasury/i;
const HLP_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

function log(msg) {
  console.info(`[ingest-leaderboard] ${msg}`);
}
function warn(msg) {
  console.warn(`[ingest-leaderboard] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Leaderboard numerics are all strings on the wire (verified 2026-07-17).
function num(v) {
  if (v === undefined || v === null) return NaN;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function windowEntry(windowPerformances, name) {
  if (!Array.isArray(windowPerformances)) return null;
  const found = windowPerformances.find(
    (p) => Array.isArray(p) && p.length === 2 && p[0] === name
  );
  return found && typeof found[1] === "object" && found[1] !== null ? found[1] : null;
}

function isVault(address, displayName) {
  if (address === HLP_ADDRESS) return true;
  if (typeof displayName === "string" && VAULT_NAME_RE.test(displayName)) return true;
  return false;
}

// Min-max normalize a set of values to [0, 1]; degenerate (empty / no
// spread) inputs fall back to a flat 0.5 rather than NaN or divide-by-zero.
function normalizeFn(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  const min = finite.length ? Math.min(...finite) : 0;
  const max = finite.length ? Math.max(...finite) : 0;
  const range = max - min;
  return (v) => (Number.isFinite(v) && range > 0 ? (v - min) / range : 0.5);
}

// Copied verbatim from upsertWalletRegistry() in src/lib/db.ts — see the
// *** SYNC WARNING *** header comment.
const UPSERT_SQL = `insert into wallet_registry
       (address, cohort, account_value, pnl_week, pnl_month, roi_month,
        turnover_month, is_tracked, first_seen, last_validated)
     values (@address, @cohort, @account_value, @pnl_week, @pnl_month, @roi_month,
        @turnover_month, @is_tracked, @first_seen, @last_validated)
     on conflict(address) do update set
       cohort = excluded.cohort,
       account_value = excluded.account_value,
       pnl_week = excluded.pnl_week,
       pnl_month = excluded.pnl_month,
       roi_month = excluded.roi_month,
       turnover_month = excluded.turnover_month,
       is_tracked = excluded.is_tracked,
       first_seen = min(wallet_registry.first_seen, excluded.first_seen),
       last_validated = excluded.last_validated`;

async function main() {
  const t0 = Date.now();

  // ── Open the existing DB. Never migrate — that's the main app's job. ──
  let db;
  try {
    db = new Database(DB_PATH, { fileMustExist: true });
  } catch (err) {
    warn(`cannot open ${DB_PATH} (${err.message}) — nothing to do`);
    process.exit(0);
  }
  // Same pragma the main app sets; harmless to repeat on a second
  // connection to the same file (this is the documented multi-process
  // pattern from db.ts's header comment). We do NOT call migrate() —
  // if wallet_registry doesn't exist yet, we bail below instead.
  db.pragma("journal_mode = WAL");

  const userVersion = db.pragma("user_version", { simple: true });
  if (userVersion < 11) {
    warn(
      `db user_version=${userVersion} < 11 — wallet_registry migration hasn't run yet ` +
        `(that's the main app's job, not this script's); exiting without fetching`
    );
    db.close();
    process.exit(0);
  }

  // ── Fetch leaderboard ────────────────────────────────────────────────
  let payload;
  try {
    const res = await fetchWithTimeout(
      LEADERBOARD_URL,
      { cache: "no-store" },
      LEADERBOARD_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (err) {
    warn(`leaderboard fetch failed (${err.message}) — keeping last-good cohort untouched`);
    db.close();
    process.exit(0);
  }

  // Defensive shape validation. The host is unofficial and can change
  // shape any day (ground rule 3) — anything short of the expected array
  // bails without writing.
  if (!payload || !Array.isArray(payload.leaderboardRows) || payload.leaderboardRows.length < 100) {
    const gotLen = Array.isArray(payload?.leaderboardRows)
      ? payload.leaderboardRows.length
      : typeof payload?.leaderboardRows;
    warn(`leaderboard payload shape unexpected (leaderboardRows=${gotLen}) — keeping last-good cohort untouched`);
    db.close();
    process.exit(0);
  }

  const rawRows = payload.leaderboardRows;

  // ── Row-level defensive parse + eligibility filters ─────────────────
  const eligiblePool = [];
  const whaleCandidates = [];

  for (const raw of rawRows) {
    if (!raw || typeof raw.ethAddress !== "string" || !Array.isArray(raw.windowPerformances)) {
      continue; // one malformed row must not abort the whole sweep
    }

    const address = raw.ethAddress.toLowerCase();
    const accountValue = num(raw.accountValue);
    const week = windowEntry(raw.windowPerformances, "week");
    const month = windowEntry(raw.windowPerformances, "month");
    const vault = isVault(address, raw.displayName);

    // Whale pass: looser bar, independent of sharp eligibility.
    if (!vault && month) {
      const pnlMonth = num(month.pnl);
      if (accountValue >= WHALE_MIN_ACCOUNT_VALUE && pnlMonth > 0) {
        whaleCandidates.push({
          address,
          accountValue,
          pnlWeek: week ? num(week.pnl) : null,
          pnlMonth,
          roiMonth: num(month.roi),
          turnoverMonth: accountValue > 0 ? num(month.vlm) / accountValue : NaN,
        });
      }
    }

    // Sharp pass requires live-window data (week AND month) present.
    if (vault || !week || !month) continue;

    const pnlWeek = num(week.pnl);
    const pnlMonth = num(month.pnl);
    const roiMonth = num(month.roi);
    const roiWeek = num(week.roi);
    const turnoverMonth = accountValue > 0 ? num(month.vlm) / accountValue : NaN;

    if (
      accountValue >= MIN_ACCOUNT_VALUE &&
      pnlWeek > 0 &&
      pnlMonth > 0 &&
      roiMonth >= MIN_ROI_MONTH &&
      Number.isFinite(turnoverMonth) &&
      turnoverMonth < MAX_TURNOVER_MONTH
    ) {
      eligiblePool.push({ address, accountValue, pnlWeek, pnlMonth, roiMonth, roiWeek, turnoverMonth });
    }
  }

  // ── Consistency scoring: normalized month-ROI + week-ROI, NOT raw PnL
  // (raw PnL selects lottery winners, not consistently-profitable wallets).
  const normMonth = normalizeFn(eligiblePool.map((r) => r.roiMonth));
  const normWeek = normalizeFn(eligiblePool.map((r) => r.roiWeek));
  eligiblePool.sort(
    (a, b) =>
      normMonth(b.roiMonth) + normWeek(b.roiWeek) - (normMonth(a.roiMonth) + normWeek(a.roiWeek))
  );
  const sharpSelected = eligiblePool.slice(0, SHARP_CAP);

  whaleCandidates.sort((a, b) => b.accountValue - a.accountValue);
  const sharpAddresses = new Set(sharpSelected.map((r) => r.address));
  const whaleSelected = [];
  for (const w of whaleCandidates) {
    if (sharpAddresses.has(w.address)) continue; // one wallet_registry row per address; sharp wins
    if (whaleSelected.length >= WHALE_CAP) break;
    whaleSelected.push(w);
  }

  // ── Liveness validation (ground rule 4) ─────────────────────────────
  const candidates = [
    ...sharpSelected.map((r) => ({ ...r, cohort: "sharp" })),
    ...whaleSelected.map((r) => ({ ...r, cohort: "whale" })),
  ];

  const survivors = [];
  let livenessDropped = 0;
  for (const c of candidates) {
    try {
      const res = await fetchWithTimeout(
        HL_INFO_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "clearinghouseState", user: c.address }),
          cache: "no-store",
        },
        LIVENESS_TIMEOUT_MS
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const state = await res.json();
      const liveAccountValue = num(state?.marginSummary?.accountValue);
      if (!Number.isFinite(liveAccountValue) || liveAccountValue < LIVENESS_MIN_ACCOUNT_VALUE) {
        livenessDropped++;
      } else {
        survivors.push({ ...c, liveAccountValue });
      }
    } catch {
      // A single wallet's liveness call failing must not abort the sweep;
      // we just can't confirm it's alive, so it doesn't get tracked.
      livenessDropped++;
    }
    await sleep(LIVENESS_SPACING_MS);
  }

  // ── Upsert survivors, untrack anyone who fell out ───────────────────
  const now = Date.now();

  if (survivors.length > 0) {
    const stmt = db.prepare(UPSERT_SQL);
    const upsertMany = db.transaction((batch) => {
      for (const r of batch) stmt.run(r);
    });
    upsertMany(
      survivors.map((s) => ({
        address: s.address,
        cohort: s.cohort,
        account_value: s.liveAccountValue,
        pnl_week: Number.isFinite(s.pnlWeek) ? s.pnlWeek : null,
        pnl_month: Number.isFinite(s.pnlMonth) ? s.pnlMonth : null,
        roi_month: Number.isFinite(s.roiMonth) ? s.roiMonth : null,
        turnover_month: Number.isFinite(s.turnoverMonth) ? s.turnoverMonth : null,
        is_tracked: 1,
        first_seen: now,
        last_validated: now,
      }))
    );
  }

  // History stays; a wallet that fell out of this ingest's selection just
  // gets is_tracked=0 (never deleted from wallet_registry).
  const survivorAddresses = new Set(survivors.map((s) => s.address));
  const currentlyTracked = db.prepare(`select address from wallet_registry where is_tracked = 1`).all();
  const toUntrack = currentlyTracked
    .map((r) => r.address)
    .filter((a) => !survivorAddresses.has(a));
  if (toUntrack.length > 0) {
    const untrackStmt = db.prepare(
      `update wallet_registry set is_tracked = 0, last_validated = ? where address = ?`
    );
    const untrackMany = db.transaction((addrs) => {
      for (const a of addrs) untrackStmt.run(now, a);
    });
    untrackMany(toUntrack);
  }

  log(
    `fetched=${rawRows.length} eligible=${eligiblePool.length} sharp=${sharpSelected.length} ` +
      `whale=${whaleSelected.length} liveness-dropped=${livenessDropped} tracked=${survivors.length} ` +
      `in ${Date.now() - t0}ms`
  );

  db.close();
  process.exit(0);
}

main().catch((err) => {
  warn(`unhandled error (${err && err.message}) — exiting without further writes`);
  process.exit(0);
});

#!/usr/bin/env node
// Smart-flow validation report (smart-flow build plan, Task 6).
//
// THE GATE: this report existing and being RUN is the precondition for any
// phase-2 alerting work. It states counts and hit-rates only — whether the
// numbers justify building alerts is the owner's call, so no thresholds are
// tuned here and no conclusion is printed.
//
// What it measures, per the plan: for each evaluation day and each coin
// where the cohort's 24h net-position change exceeded the signal floor
// (|Δ| > $250k), did the NEXT 24h of price move WITH the cohort's change
// (follow) or against it (fade)? Split by direction, by divergence vs the
// crowd's OI change, and by sector.
//
// Methodology notes (deliberate choices, mirror the live route's lessons):
// - Evaluation points are DAILY → forward windows don't overlap, so
//   samples are quasi-independent. (--step-hours lets you densify for
//   exploration; overlapping windows correlate, read those with care.)
// - The wallet set for each (T-24h → T) delta is wallets with a snapshot
//   batch at BOTH ends. This isolates position changes from cohort
//   composition churn — a wallet that joined the cohort mid-window would
//   otherwise read as a phantom inflow.
// - Crowd comparison uses only the SIGN of the crowd's OI change, computed
//   from price_snapshots' same-row oi×mark. For fractionally-quoted
//   markets (SPX) the display scale inflates oi×mark by a constant factor,
//   which cancels in a percentage-change sign — so no scale table needed.
// - Forward return uses price_snapshots marks (display units both ends —
//   ratio-safe) with a ±2h bounded lookup, same staleness posture as the
//   app's own backfills.
// - READ-ONLY: opens the DB with { readonly: true }; writes nothing.
//
// Usage:  node scripts/smart-flow-report.mjs [--days N] [--step-hours H]
//                [--min-delta USD] [--force]
//         --force runs even when the data span is under 7 days (the plan's
//         minimum for a meaningful read); output is labeled accordingly.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCREENER_DIR = path.join(SCRIPT_DIR, "..");
const DB_PATH =
  process.env.SCREENER_DB_PATH ?? path.join(SCREENER_DIR, "data", "screener.db");

const DAY_MS = 86_400_000;
const BATCH_WINDOW_MS = 30 * 60_000;   // wallet batch seek window at each end
const PRICE_TOLERANCE_MS = 2 * 3_600_000;

const args = process.argv.slice(2);
function flag(name, dflt) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = parseFloat(args[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}
const LOOKBACK_DAYS = flag("days", 30);
const STEP_MS = flag("step-hours", 24) * 3_600_000;
const MIN_DELTA_USD = flag("min-delta", 250_000);
const FORCE = args.includes("--force");

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ── Guards ────────────────────────────────────────────────────────────────
const span = db
  .prepare(`select min(ts) lo, max(ts) hi from wallet_positions`)
  .get();
if (!span?.lo) {
  console.error("no wallet_positions data at all — poller hasn't run; nothing to report");
  process.exit(1);
}
const spanDays = (span.hi - span.lo) / DAY_MS;
if (spanDays < 7 && !FORCE) {
  console.error(
    `data span is ${spanDays.toFixed(1)} days; the plan requires >= 7 for a meaningful read.\n` +
      `Earliest useful run: ${new Date(span.lo + 7 * DAY_MS).toISOString().slice(0, 10)}. ` +
      `Use --force to run anyway (output will be labeled).`
  );
  process.exit(1);
}

// ── Bounded-seek helpers (same shape as the app's DAL — see db.ts) ───────
const batchTsStmt = db.prepare(
  `select ts from wallet_positions
    where address = ? and ts <= ? and ts >= ?
    order by ts desc limit 1`
);
const batchRowsStmt = db.prepare(
  `select coin, szi, position_value from wallet_positions
    where address = ? and ts = ?`
);
const addressesInWindowStmt = db.prepare(
  `select distinct address from wallet_positions where ts <= ? and ts >= ?`
);
const priceStmt = db.prepare(
  `select mark from price_snapshots
    where symbol = ? and ts <= ? and ts >= ?
    order by ts desc limit 1`
);
const oiStmt = db.prepare(
  `select mark, oi from price_snapshots
    where symbol = ? and ts <= ? and ts >= ?
    order by ts desc limit 1`
);

// Per-coin signed net USD for one wallet set at time T. Same semantics as
// smartFlowAt: per wallet, newest batch in the window; heartbeat batches
// (coin='') contribute nothing; magnitude from position_value, sign from szi.
function netByCoin(addresses, t) {
  const net = new Map();
  for (const address of addresses) {
    const batch = batchTsStmt.get(address, t, t - BATCH_WINDOW_MS);
    if (!batch) continue;
    for (const r of batchRowsStmt.all(address, batch.ts)) {
      if (r.coin === "" || r.position_value == null) continue;
      const signed = r.szi >= 0 ? r.position_value : -r.position_value;
      net.set(r.coin, (net.get(r.coin) ?? 0) + signed);
    }
  }
  return net;
}

function walletsAt(t) {
  return new Set(
    addressesInWindowStmt.all(t, t - BATCH_WINDOW_MS).map((r) => r.address)
  );
}

function priceAt(symbol, t) {
  const r = priceStmt.get(symbol, t, t - PRICE_TOLERANCE_MS);
  return r?.mark ?? null;
}

// Sign of the crowd's 24h OI change. Display-scale cancels in the ratio.
function crowdOiSign(symbol, t) {
  const now = oiStmt.get(symbol, t, t - PRICE_TOLERANCE_MS);
  const prior = oiStmt.get(symbol, t - DAY_MS, t - DAY_MS - PRICE_TOLERANCE_MS);
  if (!now || !prior || now.oi == null || prior.oi == null) return null;
  const a = now.oi * now.mark;
  const b = prior.oi * prior.mark;
  if (!(b > 0)) return null;
  const pct = (a - b) / b;
  return pct > 0 ? 1 : pct < 0 ? -1 : 0;
}

// Sector map from the running app (read-only convenience). Degrades to
// "unknown" for every coin when the app is down — the report still runs.
async function fetchSectors() {
  try {
    const res = await fetch("http://localhost:3003/api/markets", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const assets = await res.json();
    return new Map(assets.map((a) => [a.symbol, a.sector ?? "unknown"]));
  } catch {
    console.error("(sector map unavailable — /api/markets unreachable; bucketing all coins as 'unknown')");
    return new Map();
  }
}

// ── Collect signals ──────────────────────────────────────────────────────
const sectors = await fetchSectors();
const evalStart = Math.max(span.lo + DAY_MS, span.hi - LOOKBACK_DAYS * DAY_MS);
const evalEnd = span.hi - DAY_MS; // need a full forward window
const signals = [];
let evalPoints = 0;

for (let t = evalStart; t <= evalEnd; t += STEP_MS) {
  // Wallets present at BOTH ends of the measurement window (see header).
  const atT = walletsAt(t);
  const atPrior = walletsAt(t - DAY_MS);
  const both = [...atT].filter((a) => atPrior.has(a));
  if (both.length === 0) continue;
  evalPoints++;

  const nowNet = netByCoin(both, t);
  const priorNet = netByCoin(both, t - DAY_MS);
  const coins = new Set([...nowNet.keys(), ...priorNet.keys()]);

  for (const coin of coins) {
    const delta = (nowNet.get(coin) ?? 0) - (priorNet.get(coin) ?? 0);
    if (Math.abs(delta) <= MIN_DELTA_USD) continue;

    const p0 = priceAt(coin, t);
    const p1 = priceAt(coin, t + DAY_MS);
    if (p0 == null || p1 == null || !(p0 > 0)) continue;
    const fwdPct = ((p1 - p0) / p0) * 100;

    const smartSign = delta > 0 ? 1 : -1;
    const crowdSign = crowdOiSign(coin, t);
    signals.push({
      coin,
      sector: sectors.get(coin) ?? "unknown",
      t,
      deltaUsd: delta,
      smartSign,
      fwdPct,
      follow: smartSign === (fwdPct > 0 ? 1 : fwdPct < 0 ? -1 : 0),
      diverging: crowdSign != null && crowdSign !== 0 && crowdSign !== smartSign,
      crowdKnown: crowdSign != null,
    });
  }
}

// ── Render ───────────────────────────────────────────────────────────────
const fmtUsd = (n) =>
  `${n < 0 ? "-" : "+"}$${(Math.abs(n) / 1e6).toFixed(2)}M`;
const rate = (xs) => {
  const hits = xs.filter((s) => s.follow).length;
  return xs.length
    ? `${String(hits).padStart(3)}/${String(xs.length).padEnd(3)} ${((hits / xs.length) * 100).toFixed(0)}%`
    : "  (no samples)";
};

const lines = [];
lines.push(`SMART-FLOW VALIDATION REPORT`);
lines.push(
  `data ${new Date(span.lo).toISOString().slice(0, 10)} .. ${new Date(span.hi).toISOString().slice(0, 10)}` +
    ` (${spanDays.toFixed(1)}d span${spanDays < 7 ? " — UNDER THE 7-DAY MINIMUM, forced run" : ""})`
);
lines.push(
  `eval step ${STEP_MS / 3_600_000}h · signal floor |Δ24h| > $${(MIN_DELTA_USD / 1e3).toFixed(0)}k · ${evalPoints} eval points · ${signals.length} signals`
);
lines.push("");
lines.push(`FOLLOW hit-rate (next-24h price moved WITH the cohort's net change):`);
lines.push(`  overall        ${rate(signals)}`);
lines.push(`  long-adds      ${rate(signals.filter((s) => s.smartSign > 0))}`);
lines.push(`  short-adds     ${rate(signals.filter((s) => s.smartSign < 0))}`);
lines.push(`  divergence     ${rate(signals.filter((s) => s.diverging))}   (cohort moved against crowd OI)`);
lines.push(`  agreement      ${rate(signals.filter((s) => s.crowdKnown && !s.diverging))}`);
lines.push("");
lines.push(`BY SECTOR:`);
const bySector = new Map();
for (const s of signals) {
  if (!bySector.has(s.sector)) bySector.set(s.sector, []);
  bySector.get(s.sector).push(s);
}
for (const [sector, xs] of [...bySector.entries()].sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`  ${sector.padEnd(14)} ${rate(xs)}`);
}
lines.push("");
lines.push(`TOP 10 SIGNALS BY SIZE:`);
lines.push(`  ${"date".padEnd(11)}${"coin".padEnd(10)}${"Δ24h".padStart(10)}  ${"fwd 24h".padStart(8)}  outcome`);
for (const s of [...signals].sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd)).slice(0, 10)) {
  lines.push(
    `  ${new Date(s.t).toISOString().slice(0, 10).padEnd(11)}${s.coin.padEnd(10)}` +
      `${fmtUsd(s.deltaUsd).padStart(10)}  ${(s.fwdPct > 0 ? "+" : "") + s.fwdPct.toFixed(2) + "%"}`.padEnd(34) +
      `  ${s.follow ? "follow" : "fade"}${s.diverging ? " ⚡div" : ""}`
  );
}
lines.push("");
lines.push(
  `NOTE: counts only — no conclusion is embedded by design (smart-flow plan, Task 6).` +
    ` Whether these rates justify phase-2 alerting is the owner's call. Small N and` +
    ` repeated coins across days correlate; weigh accordingly.`
);

console.log(lines.join("\n"));
db.close();

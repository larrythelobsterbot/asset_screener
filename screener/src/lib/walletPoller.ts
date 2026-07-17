// Polls Hyperliquid's clearinghouseState for every tracked wallet in the
// smart-money-flow cohort and writes wallet_positions rows. See
// docs/smart-flow-build-plan.md, Task 3.
//
// Cadence: 15 min. ~150 wallets × 1 call, paced at 300ms spacing (same
// rationale as hip3CandleWarmer's FETCH_SPACING_MS — unpaced back-to-back
// calls drain the shared 10 req/s token bucket and queue user-facing HL
// calls, like the asset modal or a signals scan, behind the sweep for
// several seconds) ≈ 45-60s per sweep at the current cohort size, well
// under the 15-min cadence.
//
// A wallet with zero open positions still writes exactly one heartbeat row
// (coin: '', szi: 0) so a coin with no cohort exposure ("cohort went flat")
// is distinguishable downstream from "the poller didn't run" (no row at
// all) — see smartFlowAt's heartbeat-batch handling in db.ts.

import { getClearinghouseState } from "./hyperliquid";
import {
  trackedWallets,
  insertWalletPositions,
  demoteWallet,
  type WalletPositionRow,
} from "./db";

const POLL_INTERVAL_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 90_000; // let boot settle, same pattern as the HIP-3 warmer
const FETCH_SPACING_MS = 300;
// A wallet erroring this many cycles in a row (vanished account, address
// typo in the cohort, permanently rate-limited, etc) gets untracked so the
// poller stops spending a call on it every cycle.
const MAX_CONSECUTIVE_FAILURES = 5;

let started = false;
let running = false; // re-entrancy guard: a slow cycle must not overlap the next

// In-memory strike counter. Resets on process restart (PM2 reload), which
// just gives every wallet a fresh set of 5 strikes — acceptable, since a
// wallet that's genuinely dead re-accumulates failures within a cycle or
// two, and we'd rather under-demote across a restart than over-demote a
// wallet that was merely unlucky during one deploy.
const consecutiveFailures = new Map<string, number>();

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  const t0 = Date.now();
  // Single ts for every row this cycle writes — same-cycle rows must be
  // comparable/groupable by ts (smartFlowAt seeks a wallet's newest batch
  // by exact ts match), so this is captured once, not per-wallet.
  const cycleTs = t0;
  let ok = 0;
  let failed = 0;
  let skippedRows = 0;
  const rows: WalletPositionRow[] = [];
  // Failures collected here and only counted as strikes AFTER the sweep,
  // and only when the cycle wasn't systemic — see below.
  const failedThisCycle: Array<{ address: string; err: unknown }> = [];

  try {
    const wallets = trackedWallets();
    for (const wallet of wallets) {
      try {
        const state = await getClearinghouseState(wallet.address);
        const accountValue = parseFloat(state.marginSummary.accountValue);

        if (state.assetPositions.length === 0) {
          rows.push({
            address: wallet.address,
            ts: cycleTs,
            coin: "",
            szi: 0,
            entry_px: null,
            position_value: 0,
            unrealized_pnl: 0,
            leverage: null,
            account_value: Number.isFinite(accountValue) ? accountValue : null,
          });
        } else {
          for (const ap of state.assetPositions) {
            const p = ap.position;
            const szi = parseFloat(p.szi);
            const positionValue = parseFloat(p.positionValue);
            // Quarantine malformed rows instead of letting them into the
            // batch: szi/position_value are NOT NULL columns, and binding
            // NaN converts to NULL in better-sqlite3 — one bad field would
            // violate the constraint and roll back the ENTIRE cycle's
            // transaction, silently losing every wallet's positions for
            // that 15-min window. (The shape validation upstream only
            // guarantees these are strings, not that they parse.)
            if (!Number.isFinite(szi) || !Number.isFinite(positionValue)) {
              skippedRows++;
              continue;
            }
            rows.push({
              address: wallet.address,
              ts: cycleTs,
              // Bare-ticker identity, same as everywhere else in the app:
              // if HL ever reports a builder-dex position under its
              // prefixed coin id ("xyz:SKHX"), the crowd-OI join in
              // smartFlow.ts and the terminal panel both key on the bare
              // ticker — an unstripped prefix would silently null the
              // divergence read for exactly the HIP-3 markets. No-op for
              // native coins.
              coin: p.coin.includes(":") ? p.coin.split(":")[1] : p.coin,
              szi,
              entry_px: p.entryPx != null ? parseFloat(p.entryPx) : null,
              position_value: positionValue,
              unrealized_pnl: parseFloat(p.unrealizedPnl),
              leverage: p.leverage?.value ?? null,
              account_value: Number.isFinite(accountValue) ? accountValue : null,
            });
          }
        }
        ok++;
        consecutiveFailures.delete(wallet.address);
      } catch (err) {
        failed++;
        failedThisCycle.push({ address: wallet.address, err });
      }
      await new Promise((r) => setTimeout(r, FETCH_SPACING_MS));
    }

    // Strike accounting happens after the sweep so a SYSTEMIC failure (HL
    // outage, network partition) can be told apart from individually dead
    // wallets. During an outage every wallet fails in lockstep; counting
    // those as strikes would demote the ENTIRE cohort within ~75 minutes
    // (5 cycles × 15 min), and the only restoration path is the next
    // daily 00:20 ingest cron — up to 24h of a dead panel from one bad
    // hour at HL. If the majority of the sweep failed, the problem is not
    // the wallets: skip strikes entirely for this cycle.
    const systemic = failed > ok;
    if (systemic && failed > 0) {
      console.warn(
        `[wallet-poller] ${failed}/${ok + failed} wallets failed — treating as systemic (HL outage?), no strikes counted`
      );
    } else {
      for (const { address, err } of failedThisCycle) {
        const failures = (consecutiveFailures.get(address) ?? 0) + 1;
        consecutiveFailures.set(address, failures);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          try {
            demoteWallet(address);
            console.warn(
              `[wallet-poller] demoted ${address} after ${failures} consecutive failures:`,
              err
            );
          } catch (demoteErr) {
            console.warn(`[wallet-poller] failed to demote ${address}:`, demoteErr);
          }
          consecutiveFailures.delete(address);
        }
      }
    }

    insertWalletPositions(rows);

    console.info(
      `[wallet-poller] ${ok} ok, ${failed} failed, ${rows.length} positions` +
        (skippedRows > 0 ? `, ${skippedRows} malformed rows skipped` : "") +
        `, ${((Date.now() - t0) / 1000).toFixed(0)}s`
    );
  } catch (err) {
    console.warn("[wallet-poller] cycle failed:", err);
  } finally {
    running = false;
  }
}

// Idempotent — safe to call from every request path, same as
// startHip3CandleWarmer / startPruneJob.
export function startWalletPoller(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    void runOnce();
    const t = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
    if (typeof t.unref === "function") t.unref();
    console.info("[wallet-poller] started (15min cycle, 300ms spacing)");
  }, FIRST_RUN_DELAY_MS);
}

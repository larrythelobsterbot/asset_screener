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
  const rows: WalletPositionRow[] = [];

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
            rows.push({
              address: wallet.address,
              ts: cycleTs,
              coin: p.coin,
              szi: parseFloat(p.szi),
              entry_px: p.entryPx != null ? parseFloat(p.entryPx) : null,
              position_value: parseFloat(p.positionValue),
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
        const failures = (consecutiveFailures.get(wallet.address) ?? 0) + 1;
        consecutiveFailures.set(wallet.address, failures);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          try {
            demoteWallet(wallet.address);
            console.warn(
              `[wallet-poller] demoted ${wallet.address} after ${failures} consecutive failures:`,
              err
            );
          } catch (demoteErr) {
            console.warn(`[wallet-poller] failed to demote ${wallet.address}:`, demoteErr);
          }
          consecutiveFailures.delete(wallet.address);
        }
      }
      await new Promise((r) => setTimeout(r, FETCH_SPACING_MS));
    }

    insertWalletPositions(rows);

    console.info(
      `[wallet-poller] ${ok} ok, ${failed} failed, ${rows.length} positions, ` +
        `${((Date.now() - t0) / 1000).toFixed(0)}s`
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

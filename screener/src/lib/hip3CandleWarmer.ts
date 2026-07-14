// Keeps candles_cache warm for the HIP-3 (builder-deployed) board.
//
// Why this exists: /api/signals only fetches candles for the crypto screener
// set, so no HIP-3 market ever landed in candles_cache. /api/markets' 7d
// change therefore fell back to a price_snapshots lookup for all 65 of them,
// which works but is bounded by our own 30-day retention and our own uptime.
// Warming the real candles gives HIP-3 the same footing as crypto — and
// because getCandlesBulkFromCache() is keyed on the bare ticker, the markets
// route picks them up with no change at that call site (it just stops needing
// its fallback).
//
// Cadence and cost: 1d bars, so there is nothing to gain from polling faster
// than the bar. ~40 markets every 6h = ~160 HL calls/day against a 10 req/s
// limiter — negligible, and the fetches are serialised through it anyway.
//
// Native HL markets are deliberately out of scope: /api/signals already warms
// the crypto set, and SPX (the one fractionally-quoted market) must stay on
// the snapshot path — its candles are in HL's raw index/20000 units while its
// snapshots are scaled, so a candle-derived 7d would read ~2,000,000%. It is
// a native market, so getBuilderUniverse() excludes it structurally rather
// than by name.

import { getBuilderUniverse, getCandles } from "./hyperliquid";

const WARM_INTERVAL_MS = 6 * 3_600_000;
const FIRST_RUN_DELAY_MS = 45_000; // let boot settle; HL WS + first scans first
const TOP_N = 40;
// Match the native crypto set's depth (/api/signals fetches 300 1d bars).
// /api/screener's ath_pct is "% off the high observed in cached candles", so
// a shallower window here would quietly make that column mean something
// different for a HIP-3 row than for a crypto one. HL returns only what
// exists — these are young listings (SKHX 146 bars, NVDA 245, XYZ100 275 as
// of 2026-07-14), so none reach ma300 and the MA grid renders those null.
// That's honest: the history genuinely isn't there yet.
const BARS = 300;

let started = false;
let running = false; // re-entrancy guard: a slow cycle must not overlap the next

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  const t0 = Date.now();
  let ok = 0;
  let empty = 0;
  let failed = 0;
  try {
    const universe = (await getBuilderUniverse()).slice(0, TOP_N);
    for (const { ticker, coin } of universe) {
      try {
        // Fetch under the dex-prefixed coin, file under the bare ticker.
        const rows = await getCandles(coin, "1d", BARS, ticker);
        if (rows.length === 0) empty++;
        else ok++;
      } catch {
        // One dead market must not abort the sweep.
        failed++;
      }
    }
    console.info(
      `[hip3-warmer] ${ok} warmed, ${empty} empty, ${failed} failed ` +
        `of ${universe.length} in ${Date.now() - t0}ms`
    );
  } catch (err) {
    console.warn("[hip3-warmer] cycle failed:", err);
  } finally {
    running = false;
  }
}

// Idempotent — safe to call from every request path, same as startPruneJob.
export function startHip3CandleWarmer(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    void runOnce();
    const t = setInterval(() => void runOnce(), WARM_INTERVAL_MS);
    if (typeof t.unref === "function") t.unref();
    console.info("[hip3-warmer] started (1d candles, top 40 HIP-3, every 6h)");
  }, FIRST_RUN_DELAY_MS);
}

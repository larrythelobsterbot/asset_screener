// Background poller for the cross-exchange derivs radar (Phase 2).
//
// Every POLL_INTERVAL_MS:
//   1. pick the top-N HL perps by 24h volume (where 20x action concentrates)
//   2. fetch aggregate OI + HL funding + windowed liquidations from Coinalyze
//   3. compute the OI×Price regime vs a fixed lookback snapshot
//   4. persist one derivs_snapshots row per coin
//
// No Telegram alerts yet (panel-only scope) — the /terminal Radar reads
// these snapshots. Idempotent startup, mirrors startHypePressurePoller.
//
// Rate budget: Coinalyze allows 40 req/min. Per cycle we issue roughly
// ceil(symbols/20) OI calls + a couple funding + a couple liq calls — well
// under budget at the 90s cadence. The /future-markets index is cached 6h.

import { getMetaAndCtxs } from "./hyperliquid";
import { getDerivsForCoins, isCoinalyzeConfigured } from "./coinalyze";
import { insertDerivsSnapshots, derivsSnapshotAt, type DerivsRow } from "./db";

const POLL_INTERVAL_MS = 90_000;
const TOP_N = 30;
// Lookback for the OI/price deltas that drive the regime read. 15min is
// long enough to be meaningful intraday, short enough to react.
const LOOKBACK_MS = 15 * 60_000;
// Dead-zones: moves smaller than this read as "flat" rather than a regime.
const OI_EPS_PCT = 0.3;
const PRICE_EPS_PCT = 0.1;

export type Regime = "new_longs" | "short_squeeze" | "new_shorts" | "long_flush" | "flat";

export function classifyRegime(oiDeltaPct: number | null, priceDeltaPct: number | null): Regime {
  if (oiDeltaPct == null || priceDeltaPct == null) return "flat";
  const oiUp = oiDeltaPct >= OI_EPS_PCT;
  const oiDown = oiDeltaPct <= -OI_EPS_PCT;
  const pxUp = priceDeltaPct >= PRICE_EPS_PCT;
  const pxDown = priceDeltaPct <= -PRICE_EPS_PCT;
  if (oiUp && pxUp) return "new_longs";        // fresh longs chasing
  if (oiUp && pxDown) return "new_shorts";      // fresh shorts pressing
  if (oiDown && pxUp) return "short_squeeze";   // shorts covering into a rip
  if (oiDown && pxDown) return "long_flush";    // longs puking / deleverage
  return "flat";
}

let started = false;
let running = false; // re-entrancy guard — see runOnce
let timer: ReturnType<typeof setInterval> | null = null;
let lastError: string | null = null;
let consecutiveErrors = 0;
let lastRunTs = 0;

// name (HL universe) → base asset. HL names are already the base for most
// perps; a few prefixed ones (e.g. kPEPE) won't map in Coinalyze and are
// dropped downstream by getDerivsForCoins.
function topCoinsByVolume(
  meta: { universe: { name: string }[] },
  ctxs: { dayNtlVlm: string; markPx: string }[]
): { base: string; price: number }[] {
  const rows = meta.universe.map((u, i) => ({
    base: u.name.toUpperCase(),
    vol: parseFloat(ctxs[i]?.dayNtlVlm || "0"),
    price: parseFloat(ctxs[i]?.markPx || "0"),
  }));
  rows.sort((a, b) => b.vol - a.vol);
  return rows.slice(0, TOP_N).map(({ base, price }) => ({ base, price }));
}

async function runOnce(): Promise<void> {
  if (!isCoinalyzeConfigured()) return;
  // A single cycle issues ~12 requests and, under 429 backoff, can run
  // longer than POLL_INTERVAL_MS. Without this guard the next interval
  // tick would start a second concurrent cycle, doubling request pressure
  // and permanently saturating the 40/min limit — the poller could never
  // recover. Skip ticks while a cycle is still in flight.
  if (running) return;
  running = true;
  try {
    const { meta, assetCtxs } = await getMetaAndCtxs();
    const top = topCoinsByVolume(meta, assetCtxs);
    const priceOf = new Map(top.map((t) => [t.base, t.price]));

    const derivs = await getDerivsForCoins(top.map((t) => t.base));
    const now = Date.now();
    const rows: DerivsRow[] = [];

    for (const d of derivs) {
      const price = priceOf.get(d.base) ?? null;
      const prior = derivsSnapshotAt(d.base, now - LOOKBACK_MS);

      let oiDeltaPct: number | null = null;
      if (prior && prior.oi_usd > 0) {
        oiDeltaPct = ((d.oiUsd - prior.oi_usd) / prior.oi_usd) * 100;
      }
      let priceDeltaPct: number | null = null;
      if (prior && prior.price && price) {
        priceDeltaPct = ((price - prior.price) / prior.price) * 100;
      }

      rows.push({
        base: d.base,
        ts: now,
        oi_usd: d.oiUsd,
        oi_hl_usd: d.oiHlUsd,
        funding_hl: d.fundingHl,
        liq_long_usd: d.liqLongUsd,
        liq_short_usd: d.liqShortUsd,
        oi_delta_pct: oiDeltaPct,
        price,
        price_delta_pct: priceDeltaPct,
        regime: classifyRegime(oiDeltaPct, priceDeltaPct),
        venues: d.venues,
      });
    }

    insertDerivsSnapshots(rows);
    lastRunTs = now;
    consecutiveErrors = 0;
    lastError = null;
    console.info(`[coinalyze] wrote ${rows.length} derivs snapshots (top ${TOP_N})`);
  } catch (err) {
    consecutiveErrors += 1;
    lastError = String(err);
    if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
      console.warn(`[coinalyze] poll #${consecutiveErrors} failed:`, lastError);
    }
  } finally {
    running = false;
  }
}

export function startCoinalyzePoller(): void {
  if (started) return;
  started = true;
  if (!isCoinalyzeConfigured()) {
    console.info("[coinalyze] no COINALYZE_API_KEY — derivs poller disabled");
    return;
  }
  // Small delay so the HL WS/markets are warm first.
  setTimeout(() => {
    runOnce();
    timer = setInterval(runOnce, POLL_INTERVAL_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  }, 8000);
}

export function getCoinalyzePollerStats(): {
  started: boolean;
  consecutiveErrors: number;
  lastError: string | null;
  lastRunTs: number;
} {
  return { started, consecutiveErrors, lastError, lastRunTs };
}

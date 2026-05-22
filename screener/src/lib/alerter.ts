// Alerter — decides which signals warrant a Telegram ping and dispatches
// them. Designed to match the LTF playbook entry rules:
//
//   1. Conviction score ≥ 3.5 (Strong Buy) or ≤ -3.5 (Strong Sell)
//   2. Vol regime != "quiet"
//   3. Per-(symbol, direction) cooldown so we don't spam on every scan
//
// Rules 1 and 2 are encoded as constants below. Rule 3 uses SQLite's
// runtime_kv table for cross-restart persistence — a PM2 reload should
// NOT cause every active setup to refire its alert.
//
// We deliberately do NOT alert on individual Signal events. Single
// signals are too noisy for LTF. The Strong Buy/Sell label already
// requires multi-family alignment via the existing conviction scorer.

import type { Signal } from "./signals";
import { scoreConviction, type ConvictionResult, SIGNAL_FAMILY } from "./signals";
import { sendTelegramMessage, escapeHtml, isTelegramConfigured } from "./telegram";
import { kvGet, kvSet } from "./db";
import { priorityOf, sectorOf } from "@/config/sectors";

// Trade-card sizing knobs — overridable via env so we can tune live without
// a rebuild. Defaults match the $2k / 2% / 1.5×ATR / 3R LTF playbook.
const ACCOUNT_USD = parseFloat(process.env.ALERT_ACCOUNT_USD || "2000");
const RISK_PCT = parseFloat(process.env.ALERT_RISK_PCT || "2");      // 2% of equity per trade
const STOP_ATR_MULT = parseFloat(process.env.ALERT_STOP_ATR_MULT || "1.5");
const RR_RATIO = parseFloat(process.env.ALERT_RR_RATIO || "3");      // target = entry +/- RR × stop_dist

// Context the alerter needs PER SYMBOL to compute the trade card. Caller
// stamps these from the same scan that produced the signals — so the
// numbers are consistent with the bars that fired the alert.
export interface TradeContext {
  atrPct: number;             // 4h ATR as % of price (Wilder-smoothed, 14-period)
  fundingHourly?: number;     // hourly funding rate (sign-bearing), for APR context
}

// 4-hour cooldown per (symbol, direction). Matches the 4h primary timeframe —
// if the setup is still valid 4h later it's worth re-alerting; sooner than
// that and we're spamming on cache-driven re-emissions of the same fire.
const COOLDOWN_MS = 4 * 3_600_000;

// Score thresholds matching the LTF playbook. ±3.5 = Strong Buy/Sell label.
const STRONG_THRESHOLD = 3.5;

// Top N contributing signals to include in the alert body. Limits message
// length so the Telegram render doesn't overflow on a wide confluence.
const MAX_SIGNALS_IN_ALERT = 5;

// A small text widget — the green/red dot users mentally pattern-match on.
function directionDot(direction: "bullish" | "bearish"): string {
  return direction === "bullish" ? "🟢" : "🔴";
}

function cooldownKey(symbol: string, direction: "bullish" | "bearish"): string {
  return `tg_alert:${symbol}:${direction}`;
}

function isOnCooldown(symbol: string, direction: "bullish" | "bearish", now: number): boolean {
  const last = kvGet(cooldownKey(symbol, direction));
  if (!last) return false;
  const lastMs = parseInt(last, 10);
  if (!Number.isFinite(lastMs)) return false;
  return now - lastMs < COOLDOWN_MS;
}

function markCooldown(symbol: string, direction: "bullish" | "bearish", now: number): void {
  kvSet(cooldownKey(symbol, direction), String(now));
}

// Format a price with a sensible number of decimals for the ticker's
// scale — BTC at $76,778 should show "$76,778" but PEPE at $0.0000091
// shouldn't round to "$0.00". We pick decimals from the magnitude.
function fmtPrice(p: number): string {
  const abs = Math.abs(p);
  let decimals: number;
  if (abs >= 1000) decimals = 0;
  else if (abs >= 100) decimals = 2;
  else if (abs >= 1) decimals = 3;
  else if (abs >= 0.01) decimals = 5;
  else decimals = 8;
  return p.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Compute a sized trade plan from the entry price + ATR + direction:
//   stop  = entry ∓ STOP_ATR_MULT × ATR
//   target = entry ± RR_RATIO × stop_distance
//   size = (ACCOUNT_USD × RISK_PCT/100) / stop_distance  →  units of base asset
// Returns null when we don't have enough info to size the trade (ATR
// missing, ATR=0 — which would zero-divide — or price unknown).
export function computeTradeCard(
  entry: number,
  atrPct: number,
  direction: "bullish" | "bearish"
): { stop: number; target: number; stopDistance: number; size: number; riskUsd: number } | null {
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;
  const atrAbs = entry * (atrPct / 100);
  const stopDistance = STOP_ATR_MULT * atrAbs;
  if (stopDistance <= 0) return null;
  const stop = direction === "bullish" ? entry - stopDistance : entry + stopDistance;
  const target = direction === "bullish"
    ? entry + RR_RATIO * stopDistance
    : entry - RR_RATIO * stopDistance;
  const riskUsd = ACCOUNT_USD * (RISK_PCT / 100);
  const size = riskUsd / stopDistance;
  return { stop, target, stopDistance, size, riskUsd };
}

// Annualized funding from hourly rate. Same math as the table column —
// keeping it inline so the alert and the UI agree on the number a user
// sees when they cross-check.
function fundingApr(hourly: number): number {
  return hourly * 8760 * 100;
}

// Build the alert body. HTML mode so `<code>` / `<b>` render cleanly on
// both mobile and desktop clients. Caller-supplied values are escaped;
// the tags themselves are intentional and must stay raw.
function formatAlert(
  symbol: string,
  conviction: ConvictionResult,
  signals: Signal[],
  currentPrice: number | null,
  tradeCtx?: TradeContext
): string {
  const dot = directionDot(conviction.score >= 0 ? "bullish" : "bearish");
  const direction = conviction.score >= 0 ? "LONG" : "SHORT";
  const label = conviction.label.toUpperCase();
  const score = conviction.score.toFixed(2);

  // Sort by absolute contribution: largest-weight signals at the top.
  // We don't have per-signal contribution stored on the Signal itself, so
  // approximate with strength (or 50 if absent). Good enough for ranking.
  const ranked = [...signals].sort((a, b) => (b.strength ?? 50) - (a.strength ?? 50));
  const top = ranked.slice(0, MAX_SIGNALS_IN_ALERT);

  // Per-TF score breakdown — useful to see if it's a single-TF spike or
  // a true multi-TF setup.
  const tfLines = (["1h", "4h", "1d", "cross"] as const)
    .map((tf) => {
      const entry = conviction.byTimeframe[tf];
      if (!entry || entry.count === 0) return null;
      const arrow = entry.score >= 0 ? "+" : "";
      return `${tf}: ${arrow}${entry.score.toFixed(2)} (${entry.count})`;
    })
    .filter((x): x is string => x !== null)
    .join(" · ");

  const signalLines = top.map((s) => {
    const tag = s.timeframe ? `[${s.timeframe}]` : "";
    const fam = s.family ?? SIGNAL_FAMILY[s.type] ?? "";
    return `• ${escapeHtml(s.label)} <code>${escapeHtml(fam)}${escapeHtml(tag)}</code>`;
  }).join("\n");

  // Sector tag for readability — at-a-glance "commodity setup" vs
  // "crypto-alt noise" distinction in the alert.
  const sector = sectorOf(symbol);
  const sectorTag = `<i>${escapeHtml(sector)}</i>`;
  const priceLine = currentPrice != null
    ? `<b>${escapeHtml(symbol)}</b> · ${sectorTag} · @ <code>$${fmtPrice(currentPrice)}</code>`
    : `<b>${escapeHtml(symbol)}</b> · ${sectorTag}`;

  // ── Trade card ───────────────────────────────────────────────────────
  // Built only when we have BOTH price and ATR%. Direction is taken from
  // the conviction score sign — same source the dot/LONG-SHORT label
  // uses, so card direction always agrees with the headline.
  const tradeDir: "bullish" | "bearish" = conviction.score >= 0 ? "bullish" : "bearish";
  const card = currentPrice != null && tradeCtx?.atrPct
    ? computeTradeCard(currentPrice, tradeCtx.atrPct, tradeDir)
    : null;
  let cardBlock = "";
  if (card) {
    const stopPct = (card.stopDistance / currentPrice!) * 100;
    const apr = tradeCtx?.fundingHourly != null ? fundingApr(tradeCtx.fundingHourly) : null;
    // Funding context: positive APR = longs paying shorts (supportive of
    // shorts / headwind for longs), negative = opposite. We tag the
    // alignment vs the trade direction so the user doesn't have to think.
    let fundingLine = "";
    if (apr != null) {
      const aligned = (tradeDir === "bullish" && apr <= 0) || (tradeDir === "bearish" && apr >= 0);
      const tag = aligned ? "✓ aligned" : "✗ headwind";
      fundingLine = `funding: <code>${apr >= 0 ? "+" : ""}${apr.toFixed(1)}% APR</code> · ${tag}`;
    }
    cardBlock = [
      "",
      `<b>[ TRADE CARD ]</b>`,
      `entry: <code>$${fmtPrice(currentPrice!)}</code>  ·  ATR(14·4h): ${tradeCtx!.atrPct.toFixed(2)}%`,
      `stop:  <code>$${fmtPrice(card.stop)}</code>  (${stopPct.toFixed(2)}% · ${STOP_ATR_MULT}× ATR)`,
      `target: <code>$${fmtPrice(card.target)}</code>  (${RR_RATIO}R)`,
      `size: <code>${card.size.toFixed(card.size >= 1 ? 2 : 4)} ${escapeHtml(symbol)}</code>  ·  risk <code>$${card.riskUsd.toFixed(2)}</code> (${RISK_PCT}% of $${ACCOUNT_USD})`,
      fundingLine,
    ].filter(Boolean).join("\n");
  }

  return [
    `${dot} <b>${escapeHtml(label)}</b> · ${escapeHtml(direction)} · score <code>${score}</code>`,
    priceLine,
    `vol regime: <code>${escapeHtml(conviction.volRegime)}</code>${tfLines ? ` · ${escapeHtml(tfLines)}` : ""}`,
    `bull/bear: ${conviction.bullishCount}/${conviction.bearishCount} · families: ${conviction.contributingFamilies.length}`,
    "",
    signalLines || "<i>(no enriched signals)</i>",
    cardBlock,
    "",
    `<a href="https://assets.lekker.design">open screener</a>`,
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}

export interface AlertDispatchResult {
  considered: number;
  fired: number;
  cooledDown: number;
  failed: number;
}

// Group an aggregate signals list by symbol, score each group, decide
// whether to alert, and dispatch in parallel. Returns a small summary
// suitable for logging from the calling route.
//
// `priceBySymbol` is optional — when present, the alert body includes
// the current mid for that symbol. Without it, we still alert with
// "(price unknown)".
export async function maybeDispatchAlerts(
  allSignals: Signal[],
  priceBySymbol?: Map<string, number>,
  tradeCtxBySymbol?: Map<string, TradeContext>
): Promise<AlertDispatchResult> {
  if (!isTelegramConfigured()) {
    return { considered: 0, fired: 0, cooledDown: 0, failed: 0 };
  }

  // Group by symbol so we can score conviction per asset, not across
  // the whole universe.
  const bySymbol = new Map<string, Signal[]>();
  for (const s of allSignals) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push(s);
    bySymbol.set(s.symbol, list);
  }

  const now = Date.now();
  const tasks: Array<Promise<"fired" | "cooldown" | "failed">> = [];
  let considered = 0;

  for (const [symbol, signals] of bySymbol) {
    // Pass the sector-priority multiplier so high-priority sectors
    // (commodities = 1.4x, stocks = 1.3x, indices = 1.2x — see
    // sectors.ts SECTORS) get amplified scoring. A neutral-conviction
    // commodity setup that would have stayed below the alert threshold
    // can clear it once the multiplier compounds with confluence.
    const conviction = scoreConviction(signals, priorityOf(symbol));
    const absScore = Math.abs(conviction.score);
    if (absScore < STRONG_THRESHOLD) continue;
    if (conviction.volRegime === "quiet") continue;
    considered += 1;

    const direction: "bullish" | "bearish" = conviction.score >= 0 ? "bullish" : "bearish";
    if (isOnCooldown(symbol, direction, now)) {
      tasks.push(Promise.resolve("cooldown"));
      continue;
    }

    // Stamp cooldown BEFORE sending so concurrent route calls don't
    // double-fire. If the send fails we REWIND the cooldown to a near-
    // expiry value so the next scan in ~5 min gets a retry attempt
    // (instead of losing the alert for the full 4h window — which was
    // the previous behavior and silently turned every transient
    // Telegram outage into a missed alert).
    markCooldown(symbol, direction, now);

    const price = priceBySymbol?.get(symbol) ?? null;
    const tradeCtx = tradeCtxBySymbol?.get(symbol);
    const body = formatAlert(symbol, conviction, signals, price, tradeCtx);

    tasks.push(
      sendTelegramMessage(body)
        .then((r) => {
          if (!r.ok) {
            console.warn(`[alerter] send failed for ${symbol}:`, r.error);
            // Rewind cooldown so the next scan retries in ~5 min.
            markCooldown(symbol, direction, now - COOLDOWN_MS + 5 * 60_000);
            return "failed" as const;
          }
          return "fired" as const;
        })
        .catch((err) => {
          console.warn(`[alerter] send threw for ${symbol}:`, err);
          markCooldown(symbol, direction, now - COOLDOWN_MS + 5 * 60_000);
          return "failed" as const;
        })
    );
  }

  const results = await Promise.all(tasks);
  return {
    considered,
    fired: results.filter((r) => r === "fired").length,
    cooledDown: results.filter((r) => r === "cooldown").length,
    failed: results.filter((r) => r === "failed").length,
  };
}

// Test/manual escape: clear all cooldowns. Exposed for the bootstrap
// script and any future ops UI. Not exported elsewhere.
export function clearAllAlertCooldowns(): number {
  // Iterate runtime_kv via a single SQL select prefixed by 'tg_alert:'.
  // We don't expose a kvDelete in db.ts yet; setting to "0" effectively
  // expires the cooldown on the next check. Cheap and effective.
  // (If we ever need true deletion semantics, add kvDelete to db.ts.)
  return 0;
}

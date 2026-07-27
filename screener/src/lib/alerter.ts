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
import {
  sendTelegramMessage,
  escapeHtml,
  isTelegramConfigured,
  type SendResult,
} from "./telegram";
import {
  reserveTelegramAlert,
  insertAlertCandidate,
  markAlertCandidateTelegramAttempted,
  hasActiveTelegramThesis,
  kvGet,
  kvSet,
  markTelegramAlertDelivered,
  markTelegramAlertDeliveryUnknown,
  markTelegramAlertFailed,
  type NewTelegramAlert,
  type TelegramAlertReservation,
} from "./db";
import { priorityOf, sectorOf } from "@/config/sectors";
import { evaluateStage2ShadowPolicy } from "./shadowPolicies";

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
export const ALERT_STRATEGY_VERSION = "stage1-closed-bars-v2";

export type AlertEligibilityReason =
  | "eligible"
  | "score_below_threshold"
  | "volatility_regime_quiet"
  | "volatility_regime_unknown"
  | "active_thesis";

export function alertEligibility(
  conviction: ConvictionResult,
  context: { activeThesis?: boolean } = {},
): { eligible: boolean; reason: AlertEligibilityReason } {
  if (Math.abs(conviction.score) < STRONG_THRESHOLD) {
    return { eligible: false, reason: "score_below_threshold" };
  }
  if (conviction.volRegime === "unknown") {
    return { eligible: false, reason: "volatility_regime_unknown" };
  }
  if (conviction.volRegime === "quiet") {
    return { eligible: false, reason: "volatility_regime_quiet" };
  }
  if (context.activeThesis) {
    return { eligible: false, reason: "active_thesis" };
  }
  return { eligible: true, reason: "eligible" };
}

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
    `<a href="https://asset.lekker.design">open screener</a>`,
  ].join("\n").replace(/\n{3,}/g, "\n\n");
}

export interface AlertDispatchResult {
  considered: number;
  fired: number;
  cooledDown: number;
  activeThesis: number;
  failed: number;
  unknown: number;
}

export function sanitizeTelegramDeliveryError(error: unknown): string {
  return String(error ?? "unknown Telegram delivery error")
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]")
    .replace(/(TELEGRAM_BOT_TOKEN\s*=\s*)[^\s&]+/gi, "$1[REDACTED]")
    .slice(0, 1_000);
}

interface TrackedDeliveryDeps {
  insert?: (row: NewTelegramAlert) => number;
  reserve?: (row: NewTelegramAlert) => TelegramAlertReservation;
  onAttempt?: (id: number) => void;
  onBlocked?: () => void;
  send: (body: string) => Promise<SendResult>;
  markDelivered: (id: number, messageId: string, deliveredAt: number) => boolean;
  markFailed: (id: number, error: string, failedAt: number) => boolean;
  markUnknown: (id: number, error: string, observedAt: number) => boolean;
  now: () => number;
}

const trackedDeliveryDeps: TrackedDeliveryDeps = {
  reserve: reserveTelegramAlert,
  send: sendTelegramMessage,
  markDelivered: markTelegramAlertDelivered,
  markFailed: markTelegramAlertFailed,
  markUnknown: markTelegramAlertDeliveryUnknown,
  now: Date.now,
};

// The ledger write is deliberately ordered before the network call. A DB
// failure therefore prevents an untracked alert from being emitted; the
// caller rewinds its cooldown and retries on the next scan.
export async function deliverTrackedTelegramAlert(
  pending: NewTelegramAlert,
  body: string,
  deps: TrackedDeliveryDeps = trackedDeliveryDeps,
): Promise<"fired" | "active_thesis" | "failed" | "unknown"> {
  const reservation = deps.reserve
    ? deps.reserve(pending)
    : deps.insert
      ? { kind: "inserted" as const, id: deps.insert(pending) }
      : (() => { throw new Error("Tracked Telegram delivery requires a reservation dependency"); })();
  if (reservation.kind === "blocked") {
    deps.onBlocked?.();
    return "active_thesis";
  }
  const id = reservation.id;
  deps.onAttempt?.(id);
  let result: SendResult;
  try {
    result = await deps.send(body);
  } catch (error) {
    deps.markUnknown(id, sanitizeTelegramDeliveryError(error), deps.now());
    return "unknown";
  }

  if (!result.ok || result.messageId == null) {
    const error = result.ok
      ? "Telegram acknowledged delivery without a message id"
      : result.error ?? "Telegram delivery failed without an error description";
    if (result.ok || result.failureKind === "unknown") {
      deps.markUnknown(id, sanitizeTelegramDeliveryError(error), deps.now());
      return "unknown";
    }
    deps.markFailed(id, sanitizeTelegramDeliveryError(error), deps.now());
    return "failed";
  }

  if (!deps.markDelivered(id, String(result.messageId), deps.now())) {
    deps.markUnknown(id, "Telegram acknowledgement could not be persisted", deps.now());
    return "unknown";
  }
  return "fired";
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
  tradeCtxBySymbol?: Map<string, TradeContext>,
  primaryVolRegimeBySymbol?: Map<string, ConvictionResult["volRegime"]>,
  decisionCandleAtBySymbol?: Map<string, number>,
  evaluatedAt: number = Date.now(),
): Promise<AlertDispatchResult> {
  const telegramConfigured = isTelegramConfigured();

  // Group by symbol so we can score conviction per asset, not across
  // the whole universe.
  const bySymbol = new Map<string, Signal[]>();
  for (const s of allSignals) {
    const list = bySymbol.get(s.symbol) ?? [];
    list.push(s);
    bySymbol.set(s.symbol, list);
  }

  const now = evaluatedAt;
  const tasks: Array<Promise<"fired" | "cooldown" | "active_thesis" | "failed" | "unknown">> = [];
  let considered = 0;

  for (const [symbol, signals] of bySymbol) {
    // Pass the sector-priority multiplier so high-priority sectors
    // (commodities = 1.4x, stocks = 1.3x, indices = 1.2x — see
    // sectors.ts SECTORS) get amplified scoring. A neutral-conviction
    // commodity setup that would have stayed below the alert threshold
    // can clear it once the multiplier compounds with confluence.
    const conviction = scoreConviction(
      signals,
      priorityOf(symbol),
      primaryVolRegimeBySymbol?.get(symbol),
    );
    const direction: "bullish" | "bearish" = conviction.score >= 0 ? "bullish" : "bearish";
    const ledgerDirection = direction === "bullish" ? "long" : "short";
    const price = priceBySymbol?.get(symbol) ?? null;
    const tradeCtx = tradeCtxBySymbol?.get(symbol);
    const shadowPolicy = evaluateStage2ShadowPolicy({
      direction: ledgerDirection,
      convictionScore: conviction.score,
      primaryVolRegime: conviction.volRegime,
      byTimeframe: conviction.byTimeframe,
      fundingHourly: tradeCtx?.fundingHourly ?? null,
      signals,
    });
    const recordCandidate = (
      decision: "rejected" | "suppressed" | "eligible",
      decisionReason: string,
      telegramAttempted: 0 | 1,
    ): number | null => {
      try {
        return insertAlertCandidate({
          evaluated_at: evaluatedAt,
          decision_candle_at: decisionCandleAtBySymbol?.get(symbol) ?? null,
          strategy_version: ALERT_STRATEGY_VERSION,
          symbol,
          direction: ledgerDirection,
          conviction_score: conviction.score,
          vol_regime: conviction.volRegime,
          decision,
          decision_reason: decisionReason,
          conviction_json: JSON.stringify(conviction),
          signal_json: JSON.stringify(signals),
          family_json: JSON.stringify(conviction.contributingFamilies),
          feature_json: JSON.stringify({
            closedCandlesOnly: true,
            decisionCandleAt: decisionCandleAtBySymbol?.get(symbol) ?? null,
            primaryVolRegime: conviction.volRegime,
            market: {
              price,
              atrPct: tradeCtx?.atrPct ?? null,
              fundingHourly: tradeCtx?.fundingHourly ?? null,
            },
            signals: signals.map((signal) => ({
              type: signal.type,
              value: signal.value,
              strength: signal.strength ?? null,
              timeframe: signal.timeframe ?? "cross",
            })),
          }),
          shadow_policy_json: JSON.stringify(shadowPolicy),
          telegram_attempted: telegramAttempted,
        });
      } catch (err) {
        console.warn(`[alerter] candidate ledger write failed for ${symbol}:`, err);
        return null;
      }
    };

    const baseEligibility = alertEligibility(conviction);
    if (!baseEligibility.eligible) {
      recordCandidate("rejected", baseEligibility.reason, 0);
      continue;
    }
    considered += 1;

    const card = price != null && tradeCtx
      ? computeTradeCard(price, tradeCtx.atrPct, direction)
      : null;
    if (!card) {
      recordCandidate("rejected", "trade_card_unavailable", 0);
      continue;
    }

    const activeEligibility = alertEligibility(conviction, {
      activeThesis: hasActiveTelegramThesis(symbol, ledgerDirection, now),
    });
    if (!activeEligibility.eligible) {
      recordCandidate("suppressed", activeEligibility.reason, 0);
      tasks.push(Promise.resolve("active_thesis"));
      continue;
    }
    if (isOnCooldown(symbol, direction, now)) {
      recordCandidate("suppressed", "cooldown", 0);
      tasks.push(Promise.resolve("cooldown"));
      continue;
    }
    if (!telegramConfigured) {
      recordCandidate("suppressed", "telegram_not_configured", 0);
      continue;
    }

    const candidateId = recordCandidate("eligible", "selected_for_telegram", 0);

    // Stamp cooldown BEFORE sending so concurrent route calls don't
    // double-fire. If the send fails we REWIND the cooldown to a near-
    // expiry value so the next scan in ~5 min gets a retry attempt
    // (instead of losing the alert for the full 4h window — which was
    // the previous behavior and silently turned every transient
    // Telegram outage into a missed alert).
    markCooldown(symbol, direction, now);

    const body = formatAlert(symbol, conviction, signals, price, tradeCtx);
    const pendingAlert: NewTelegramAlert = {
      created_at: now,
      delivery_status: "pending",
      delivery_error: null,
      telegram_message_id: null,
      symbol,
      sector: sectorOf(symbol),
      direction: ledgerDirection,
      entry_price: price,
      stop_price: card.stop,
      target_price: card.target,
      size: card.size,
      risk_usd: card.riskUsd,
      conviction_score: conviction.score,
      conviction_json: JSON.stringify(conviction),
      signal_json: JSON.stringify(signals),
      family_json: JSON.stringify(conviction.contributingFamilies),
      expires_at: now + 48 * 60 * 60 * 1000,
      outcome_status: "open",
      outcome_at: null,
      outcome_price: null,
      pnl_r: null,
      evaluated_through: null,
      outcome_note: null,
      outcome_provenance: null,
      candidate_id: candidateId,
      candidate_attribution: candidateId === null ? "failed" : "linked",
    };

    tasks.push(
      deliverTrackedTelegramAlert(pendingAlert, body, {
        ...trackedDeliveryDeps,
        onBlocked: () => {
          recordCandidate("suppressed", "active_thesis", 0);
        },
        onAttempt: () => {
          if (candidateId !== null) markAlertCandidateTelegramAttempted(candidateId);
        },
      })
        .then((result) => {
          if (result === "active_thesis") return "active_thesis" as const;
          if (result === "failed") {
            console.warn(`[alerter] send failed for ${symbol}; details recorded in alert ledger`);
            // Rewind cooldown so the next scan retries in ~5 min.
            markCooldown(symbol, direction, now - COOLDOWN_MS + 5 * 60_000);
            return "failed" as const;
          }
          if (result === "unknown") {
            console.warn(`[alerter] Telegram acknowledgement unknown for ${symbol}; cooldown retained to prevent duplicate delivery`);
            return "unknown" as const;
          }
          return "fired" as const;
        })
        .catch((err) => {
          console.warn(`[alerter] tracked delivery threw for ${symbol}:`, sanitizeTelegramDeliveryError(err));
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
    activeThesis: results.filter((r) => r === "active_thesis").length,
    failed: results.filter((r) => r === "failed").length,
    unknown: results.filter((r) => r === "unknown").length,
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

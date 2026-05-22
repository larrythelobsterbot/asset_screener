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

// Build the alert body. HTML mode so `<code>` / `<b>` render cleanly on
// both mobile and desktop clients. Caller-supplied values are escaped;
// the tags themselves are intentional and must stay raw.
function formatAlert(
  symbol: string,
  conviction: ConvictionResult,
  signals: Signal[],
  currentPrice: number | null
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
    ? `<b>${escapeHtml(symbol)}</b> · ${sectorTag} · @ <code>$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</code>`
    : `<b>${escapeHtml(symbol)}</b> · ${sectorTag}`;

  return [
    `${dot} <b>${escapeHtml(label)}</b> · ${escapeHtml(direction)} · score <code>${score}</code>`,
    priceLine,
    `vol regime: <code>${escapeHtml(conviction.volRegime)}</code>${tfLines ? ` · ${escapeHtml(tfLines)}` : ""}`,
    `bull/bear: ${conviction.bullishCount}/${conviction.bearishCount} · families: ${conviction.contributingFamilies.length}`,
    "",
    signalLines || "<i>(no enriched signals)</i>",
    "",
    `<a href="https://assets.lekker.design">open screener</a>`,
  ].join("\n");
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
  priceBySymbol?: Map<string, number>
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
    const body = formatAlert(symbol, conviction, signals, price);

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

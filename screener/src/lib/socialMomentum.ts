// Attention radar — mention-ACCELERATION over the accumulated
// social_snapshots history, cross-referenced with price.
//
// Elfa's change_percent (which social_spike consumes) compares the
// current 24h window against the previous one — a single one-shot delta.
// This module instead ranks each symbol's LATEST 24h mention count
// against its own trailing baseline built from many hourly snapshots,
// which catches attention building steadily over days, not just
// overnight doublings. Crossing that with price change gives the two
// divergence reads that matter:
//
//   quiet_accumulation — attention accelerating, price hasn't moved.
//                        The window where being early is possible.
//   hollow_pump        — price up hard, attention FADING vs baseline.
//                        Move without organic interest; exit-liquidity
//                        shaped.
//   confirmed_move     — attention and price rising together.
//   accelerating       — attention accelerating, no price data (not on
//                        HL / not snapshotted). Pure discovery bucket.
//
// Everything here reads SQLite only — zero Elfa credits. The history it
// depends on accumulates via the instrumentation keepalive pinging
// /api/social/trending hourly.

import { loadEventHistory, recordEventFire, eventHistoryKey } from "./db";
import type { Signal } from "./signals";

export interface SocialSeriesPoint {
  ts: number;
  mentions: number;
}

export interface MomentumInput {
  symbol: string;                 // UPPERCASE
  series: SocialSeriesPoint[];    // oldest-first hourly snapshots (24h rolling counts)
  price24hPct: number | null;     // null = no HL price context for this ticker
  isHL: boolean;
}

export type AttentionClass =
  | "quiet_accumulation"
  | "hollow_pump"
  | "confirmed_move"
  | "accelerating";

export interface MomentumRow {
  symbol: string;
  isHL: boolean;
  mentions: number;               // latest 24h rolling count
  baseline: number;               // trailing mean of the same metric
  accel: number;                  // mentions / baseline (1 = no change)
  zScore: number | null;          // vs trailing distribution; null if flat history
  price24hPct: number | null;
  klass: AttentionClass | null;   // null = nothing noteworthy
  series: number[];               // mention counts for sparklines, oldest-first
  seriesSpanHours: number;
}

// Thresholds. Deliberately conservative — this feeds a discovery panel
// and a paper track record, not the conviction scorer. Snapshots are a
// 24h ROLLING window sampled hourly, so consecutive points overlap ~96%
// and the series is heavily autocorrelated; the accel ratio (not the
// z-score) is the primary gate for exactly that reason.
const MIN_POINTS = 4;                 // baseline needs at least this many points
const MIN_SPAN_MS = 12 * 3_600_000;   // …spanning at least 12h of history
const MIN_MENTIONS = 30;              // ignore tickers that went 3 → 9 mentions
const ACCEL_MIN = 2;                  // 2× trailing baseline = accelerating
const PRICE_FLAT_PCT = 2;             // |24h| < 2% = "price hasn't reacted"
const PRICE_PUMP_PCT = 5;             // ≥ 5% 24h = "price moved hard"
const FADE_MAX = 0.7;                 // ≤ 0.7× baseline = attention fading

function classify(
  accel: number,
  mentions: number,
  baseline: number,
  price24hPct: number | null,
): AttentionClass | null {
  const accelerating = accel >= ACCEL_MIN && mentions >= MIN_MENTIONS;
  if (accelerating) {
    if (price24hPct == null) return "accelerating";
    if (Math.abs(price24hPct) < PRICE_FLAT_PCT) return "quiet_accumulation";
    if (price24hPct >= PRICE_PUMP_PCT) return "confirmed_move";
    return "accelerating";
  }
  // Fade check keys on the BASELINE being meaningful — a pump on a coin
  // that never had mentions isn't a divergence, it's just off-radar.
  if (
    price24hPct != null &&
    price24hPct >= PRICE_PUMP_PCT &&
    accel <= FADE_MAX &&
    baseline >= MIN_MENTIONS
  ) {
    return "hollow_pump";
  }
  return null;
}

export function computeSocialMomentum(inputs: MomentumInput[]): MomentumRow[] {
  const out: MomentumRow[] = [];
  for (const inp of inputs) {
    const series = inp.series;
    if (series.length < MIN_POINTS + 1) continue;
    const spanMs = series[series.length - 1].ts - series[0].ts;
    if (spanMs < MIN_SPAN_MS) continue;

    const latest = series[series.length - 1].mentions;
    const hist = series.slice(0, -1).map((p) => p.mentions);
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    // Floor the baseline at 1 so brand-new tickers (baseline ≈ 0) get a
    // huge-but-finite accel instead of Infinity.
    const baseline = Math.max(1, mean);
    const accel = latest / baseline;

    const variance =
      hist.reduce((a, b) => a + (b - mean) * (b - mean), 0) / hist.length;
    const std = Math.sqrt(variance);
    const zScore = std > 0 ? (latest - mean) / std : null;

    out.push({
      symbol: inp.symbol,
      isHL: inp.isHL,
      mentions: latest,
      baseline: Math.round(baseline * 10) / 10,
      accel: Math.round(accel * 100) / 100,
      zScore: zScore == null ? null : Math.round(zScore * 100) / 100,
      price24hPct: inp.price24hPct,
      klass: classify(accel, latest, baseline, inp.price24hPct),
      series: series.map((p) => p.mentions),
      seriesSpanHours: Math.round(spanMs / 3_600_000),
    });
  }
  // Rank: classified rows first (by accel), then unclassified by accel.
  // hollow_pump rows have LOW accel by construction, so give classified
  // rows a large fixed boost rather than sorting purely on the ratio.
  out.sort((a, b) => {
    const ka = a.klass ? 1 : 0;
    const kb = b.klass ? 1 : 0;
    if (ka !== kb) return kb - ka;
    return b.accel - a.accel;
  });
  return out;
}

// ── Persistence bridge ──────────────────────────────────────────────────
// Turns classified rows into Signal-shaped events for signal_events, so
// evaluate-outcomes.ts grades them at 1h/4h/24h like every other signal
// type. De-bounced through event_history (12h per symbol+type) — the
// momentum route recomputes every few minutes and logSignalFires' dedup
// key includes fired_at, so without this every recompute would insert a
// fresh row.
//
// Direction mapping: hollow_pump → bearish (attention says fade the
// move); everything classified else → bullish. Only HL-listed symbols
// are persisted — outcome evaluation needs a price series, and the
// evaluator reads HL prices.

const SOCIAL_SIGNAL_DEBOUNCE_MS = 12 * 3_600_000;

let socialEventHistory: Map<string, number> | null = null;

function getSocialEventHistory(): Map<string, number> {
  if (socialEventHistory) return socialEventHistory;
  try {
    socialEventHistory = loadEventHistory();
  } catch (err) {
    console.warn("[socialMomentum] event history hydrate failed, in-memory only:", err);
    socialEventHistory = new Map();
  }
  return socialEventHistory;
}

export function buildSocialSignals(rows: MomentumRow[]): Signal[] {
  const now = Date.now();
  const history = getSocialEventHistory();
  const out: Signal[] = [];
  for (const r of rows) {
    if (!r.klass || !r.isHL) continue;
    const type = r.klass === "hollow_pump" ? "social_divergence" : "social_accel";
    const key = eventHistoryKey(r.symbol, type, "cross");
    const last = history.get(key);
    if (last && now - last < SOCIAL_SIGNAL_DEBOUNCE_MS) continue;
    history.set(key, now);
    try {
      recordEventFire(r.symbol, type, now, "cross");
    } catch (err) {
      console.warn(`[socialMomentum] persist fire(${key}) failed:`, err);
    }
    const direction = r.klass === "hollow_pump" ? "bearish" : "bullish";
    // Strength: accel 2× → 40, 5×+ → 100 (mirrors the volume_spike ramp).
    // hollow_pump keys on how hard attention faded instead.
    const strength =
      r.klass === "hollow_pump"
        ? Math.min(100, 40 + ((FADE_MAX - r.accel) / FADE_MAX) * 60)
        : Math.min(100, 40 + ((r.accel - ACCEL_MIN) / 3) * 60);
    out.push({
      symbol: r.symbol,
      type,
      family: "social",
      direction,
      value: r.accel,
      strength: Math.round(strength),
      label:
        r.klass === "hollow_pump"
          ? `Hollow pump: +${r.price24hPct?.toFixed(1)}% 24h but mentions ${r.accel.toFixed(2)}× baseline`
          : `${r.klass.replace("_", " ")}: ${r.mentions} mentions, ${r.accel.toFixed(1)}× baseline` +
            (r.price24hPct != null ? `, ${r.price24hPct >= 0 ? "+" : ""}${r.price24hPct.toFixed(1)}% 24h` : ""),
      firedAt: now,
      timeframe: "cross",
    });
  }
  return out;
}

// Test-only escape hatch, mirrors signals.ts.
export function _resetSocialEventHistoryForTests(): void {
  socialEventHistory = null;
}

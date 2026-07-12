import {
  computeAllIndicators,
  detectDivergences,
  atrPercent,
  classifyVolRegime,
  type VolRegime,
} from "./indicators";
import type { Sector } from "@/config/sectors";
import { loadEventHistory, recordEventFire, eventHistoryKey } from "./db";

// Grouping signals by family makes downstream consumers (bot, UI) much easier
// to reason about — e.g., "only act on momentum+trend confluence" or
// "never alert on volume alone". The legacy `type` stays as a fine-grained
// identifier so existing consumers don't break.
export type SignalFamily =
  | "momentum"
  | "trend"
  | "volume"
  | "structure"
  | "funding"
  // "social" sits alongside the other families. Currently sourced from
  // Elfa AI mindshare data (data/social_snapshots). Treated like volume
  // in the scorer — high attention is a setup, not a direction by
  // itself; the direction comes from accompanying momentum/trend signals.
  | "social";

export type SignalType =
  | "rsi_overbought"
  | "rsi_oversold"
  | "rsi_divergence_bullish"
  | "rsi_divergence_bearish"
  | "macd_bullish"
  | "macd_bearish"
  | "volume_spike"
  | "breakout_up"
  | "breakout_down"
  | "funding_anomaly"
  | "ema_bullish"
  | "ema_bearish"
  | "golden_cross"
  | "death_cross"
  | "sector_leader"
  | "sector_laggard"
  | "social_spike"
  // Attention-radar types (src/lib/socialMomentum.ts). Persisted to
  // signal_events for outcome tracking but deliberately NOT emitted in
  // the /api/signals stream — they must not perturb conviction scoring
  // or the alerter until the track record says they earn a weight.
  | "social_accel"
  | "social_divergence";

export type SignalDirection = "bullish" | "bearish";

// Canonical timeframes we run signal detection on. `cross` is reserved for
// cross-sectional signals like sector-RS that aren't tied to a single bar
// length, so confluence scoring can treat them separately.
export type Timeframe = "1h" | "4h" | "1d" | "cross";

export interface Signal {
  symbol: string;
  type: SignalType;
  family: SignalFamily;
  direction: SignalDirection;
  value: number;
  label: string;
  firedAt: number;
  // Optional enrichment. Present where the caller had the data available.
  strength?: number;       // 0-100, normalized intensity
  volRegime?: VolRegime;   // gates consumers that want to suppress noise signals in wild markets
  timeframe?: Timeframe;   // set when the signal comes from a specific-TF scan
}

// Maps every SignalType to its family. Exported so the bot/UI can filter
// without re-implementing the taxonomy. Keep in sync with SignalType.
export const SIGNAL_FAMILY: Record<SignalType, SignalFamily> = {
  rsi_overbought: "momentum",
  rsi_oversold: "momentum",
  rsi_divergence_bullish: "momentum",
  rsi_divergence_bearish: "momentum",
  macd_bullish: "momentum",
  macd_bearish: "momentum",
  volume_spike: "volume",
  breakout_up: "structure",
  breakout_down: "structure",
  funding_anomaly: "funding",
  ema_bullish: "trend",
  ema_bearish: "trend",
  golden_cross: "trend",
  death_cross: "trend",
  sector_leader: "structure",
  sector_laggard: "structure",
  social_spike: "social",
  social_accel: "social",
  social_divergence: "social",
};

// In-memory de-bouncer map. Hydrated from SQLite on first use so a PM2
// restart doesn't refire every persistent signal at once; writes are
// mirrored to SQLite synchronously (cheap — single-row insert/update).
// Module-level lazy init so tests that don't touch signals don't pay
// the load cost.
let eventHistory: Map<string, number> | null = null;

function getEventHistory(): Map<string, number> {
  if (eventHistory) return eventHistory;
  try {
    eventHistory = loadEventHistory();
  } catch (err) {
    // If SQLite isn't available (tests, broken disk) we silently degrade
    // to an in-memory map. Refire behaviour is then "as if just restarted",
    // which is exactly the legacy behaviour — no regression.
    console.warn("[signals] event history hydrate failed, using in-memory only:", err);
    eventHistory = new Map();
  }
  return eventHistory;
}

const PERSISTENCE: Partial<Record<SignalType, number>> = {
  macd_bullish: 24 * 3_600_000,
  macd_bearish: 24 * 3_600_000,
  breakout_up: 24 * 3_600_000,
  breakout_down: 24 * 3_600_000,
  ema_bullish: 24 * 3_600_000,
  ema_bearish: 24 * 3_600_000,
  golden_cross: 48 * 3_600_000,
  death_cross: 48 * 3_600_000,
};

function fireEvent(
  symbol: string,
  type: SignalType,
  direction: SignalDirection,
  value: number,
  label: string,
  timeframe?: Timeframe,
): Omit<Signal, "family" | "volRegime"> | null {
  // Returns a partial signal so the caller can stamp family + volRegime via
  // the `tag()` helper. Keeping those two fields out here prevents us from
  // having to thread the regime through every fireEvent call.
  //
  // De-bouncer key INCLUDES timeframe: the signals route scans 1h, 4h, 1d
  // sequentially, and we want multi-TF confluence — a macd_bullish on 1h
  // must not suppress the same signal on 4h+1d (that would silently
  // undercount the conviction scorer's cross-TF alignment bonus).
  const history = getEventHistory();
  const key = eventHistoryKey(symbol, type, timeframe);
  const now = Date.now();
  const lastFired = history.get(key);
  const persist = PERSISTENCE[type] || 24 * 3_600_000;
  if (lastFired && now - lastFired < persist) return null;
  history.set(key, now);
  try {
    recordEventFire(symbol, type, now, timeframe);
  } catch (err) {
    // Write failure is non-fatal — the in-memory map still de-bounces
    // for this process lifetime. Logged so we know if disk goes bad.
    console.warn(`[signals] persist fire(${key}) failed:`, err);
  }
  return { symbol, type, direction, value, label, firedAt: now };
}

// Test-only escape hatch: clear the in-memory cache so a follow-up call
// re-hydrates from SQLite. Used by db.test.ts to prove that recorded
// fires survive a "restart".
export function _resetEventHistoryForTests(): void {
  eventHistory = null;
}

export function detectSignals(
  symbol: string,
  closes: number[],
  volumes: number[],
  highs: number[],
  lows: number[],
  fundingRate?: number,
  fundingHistory?: number[],
  timeframe?: Timeframe
): Signal[] {
  if (closes.length < 30) return [];

  const signals: Signal[] = [];
  const ind = computeAllIndicators(closes);
  const last = closes.length - 1;

  // Volatility regime: last ATR% value vs its own history over the same
  // series. Signals are tagged with this so consumers can suppress noise in
  // wild regimes (e.g., RSI extremes are far more common during volatility
  // spikes and mean less than in a quiet tape).
  const atrSeries = atrPercent(highs, lows, closes, 14);
  const currentAtr = atrSeries[last];
  // Everything EXCEPT the latest value is "history" to rank the current bar
  // against. Take the previous ~90 bars so we don't let stale regime info
  // dominate a long-lived series.
  const atrHist = atrSeries.slice(Math.max(0, last - 90), last);
  const volRegime = classifyVolRegime(currentAtr, atrHist);

  // tag() stamps every emitted signal with the scan-level metadata
  // (family derived from type, volRegime + timeframe from this invocation).
  // Input signals may not have those fields yet; any timeframe on the input
  // is deliberately overridden by the caller's `timeframe` argument.
  const tag = (s: Omit<Signal, "family" | "volRegime">): Signal => ({
    ...s,
    family: SIGNAL_FAMILY[s.type],
    volRegime,
    timeframe,
  });

  // Local fireEvent that captures `timeframe` from this scan so every
  // persistent-window signal gets de-bounced per (symbol, type, tf)
  // rather than globally. Keeps the per-call-site signature compact.
  const fire = (
    type: SignalType,
    direction: SignalDirection,
    value: number,
    label: string,
  ) => fireEvent(symbol, type, direction, value, label, timeframe);

  // RSI
  const rsiVal = ind.rsi[last];
  if (rsiVal !== null) {
    if (rsiVal > 70) {
      signals.push(tag({
        symbol, type: "rsi_overbought", direction: "bearish",
        value: rsiVal,
        // Strength ramps from 0 at RSI 70 → 100 at RSI 90+
        strength: Math.min(100, ((rsiVal - 70) / 20) * 100),
        label: `RSI Overbought (${rsiVal.toFixed(1)})`, firedAt: Date.now(),
      }));
    }
    if (rsiVal < 30) {
      signals.push(tag({
        symbol, type: "rsi_oversold", direction: "bullish",
        value: rsiVal,
        strength: Math.min(100, ((30 - rsiVal) / 20) * 100),
        label: `RSI Oversold (${rsiVal.toFixed(1)})`, firedAt: Date.now(),
      }));
    }
  }

  // RSI divergence — higher-conviction than plain RSI levels; these get
  // weighted heavier in the confluence scorer because they signal
  // exhaustion, not just extension.
  const rsiForDiv = ind.rsi.slice(Math.max(0, last - 30), last + 1);
  const closesForDiv = closes.slice(Math.max(0, last - 30), last + 1);
  const div = detectDivergences(closesForDiv, rsiForDiv, 30);
  if (div.bullish) {
    const s = fire("rsi_divergence_bullish", "bullish", 0, div.description ?? "Bullish RSI divergence");
    if (s) signals.push(tag({ ...s, strength: 75 }));
  }
  if (div.bearish) {
    const s = fire("rsi_divergence_bearish", "bearish", 0, div.description ?? "Bearish RSI divergence");
    if (s) signals.push(tag({ ...s, strength: 75 }));
  }

  // MACD crossover
  const m = ind.macd;
  if (m.macd[last] != null && m.signal[last] != null && m.macd[last - 1] != null && m.signal[last - 1] != null) {
    const prev = m.macd[last - 1]! - m.signal[last - 1]!;
    const curr = m.macd[last]! - m.signal[last]!;
    if (prev < 0 && curr >= 0) {
      const s = fire("macd_bullish", "bullish", curr, "MACD Bullish Cross");
      if (s) signals.push(tag(s));
    }
    if (prev > 0 && curr <= 0) {
      const s = fire("macd_bearish", "bearish", curr, "MACD Bearish Cross");
      if (s) signals.push(tag(s));
    }
  }

  // Volume spike
  if (volumes.length >= 21) {
    const avg = volumes.slice(last - 20, last).reduce((a, b) => a + b, 0) / 20;
    if (avg > 0 && volumes[last] > 2 * avg) {
      const ratio = volumes[last] / avg;
      signals.push(tag({
        symbol, type: "volume_spike", direction: "bullish",
        value: ratio,
        // 2x = 40, 5x = 100. Caps the tail so a 20× spike doesn't dominate.
        strength: Math.min(100, ((ratio - 2) / 3) * 60 + 40),
        label: `Volume Spike (${ratio.toFixed(1)}x)`, firedAt: Date.now(),
      }));
    }
  }

  // Price breakout
  if (highs.length >= 21) {
    const highest = Math.max(...highs.slice(last - 20, last));
    const lowest = Math.min(...lows.slice(last - 20, last));
    if (closes[last] > highest) {
      const s = fire("breakout_up", "bullish", closes[last], `Breakout Up`);
      if (s) signals.push(tag(s));
    }
    if (closes[last] < lowest) {
      const s = fire("breakout_down", "bearish", closes[last], `Breakout Down`);
      if (s) signals.push(tag(s));
    }
  }

  // Funding rate anomaly — percentile-based against this symbol's own history.
  // Rationale: a flat "> 0.01%/hr" threshold fires on nearly every perp all
  // the time (that's already ~88% APR). We only care about funding that is
  // anomalously high/low relative to this coin's recent baseline, so we
  // require the current rate to sit in the top/bottom decile of the last
  // FUNDING_WINDOW samples. If history isn't supplied we fall back to a
  // conservative absolute threshold so the check still catches egregious
  // cases on cold start.
  if (fundingRate !== undefined) {
    const hist = fundingHistory ?? [];
    const samples = hist.filter((x) => Number.isFinite(x));
    if (samples.length >= 24) {
      // Need at least ~1 day of hourly samples for the percentiles to mean
      // anything. Copy before sorting to avoid mutating the caller's array.
      const sorted = [...samples].sort((a, b) => a - b);
      const p10 = sorted[Math.floor(sorted.length * 0.10)];
      const p90 = sorted[Math.floor(sorted.length * 0.90)];
      if (fundingRate >= p90 && fundingRate > 0.0001) {
        signals.push(tag({
          symbol, type: "funding_anomaly",
          direction: "bearish",
          value: fundingRate,
          strength: 60,
          label: `Funding top-decile (${(fundingRate * 100).toFixed(4)}%)`,
          firedAt: Date.now(),
        }));
      } else if (fundingRate <= p10 && fundingRate < -0.00005) {
        signals.push(tag({
          symbol, type: "funding_anomaly",
          direction: "bullish",
          value: fundingRate,
          strength: 60,
          label: `Funding bottom-decile (${(fundingRate * 100).toFixed(4)}%)`,
          firedAt: Date.now(),
        }));
      }
    } else if (Math.abs(fundingRate) > 0.0005) {
      // Cold-start fallback: 0.05%/hr ≈ 440% APR — genuinely extreme.
      signals.push(tag({
        symbol, type: "funding_anomaly",
        direction: fundingRate > 0 ? "bearish" : "bullish",
        value: fundingRate,
        strength: 80,
        label: `Funding ${fundingRate > 0 ? "extreme-high" : "extreme-low"} (${(fundingRate * 100).toFixed(4)}%)`,
        firedAt: Date.now(),
      }));
    }
  }

  // EMA 13/25 crossover
  if (ind.ema13[last] != null && ind.ema25[last] != null && ind.ema13[last - 1] != null && ind.ema25[last - 1] != null) {
    const prev = ind.ema13[last - 1]! - ind.ema25[last - 1]!;
    const curr = ind.ema13[last]! - ind.ema25[last]!;
    if (prev < 0 && curr >= 0) {
      const s = fire("ema_bullish", "bullish", curr, "EMA 13/25 Bullish Cross");
      if (s) signals.push(tag(s));
    }
    if (prev > 0 && curr <= 0) {
      const s = fire("ema_bearish", "bearish", curr, "EMA 13/25 Bearish Cross");
      if (s) signals.push(tag(s));
    }
  }

  // Golden / Death cross: MA100 vs MA300.
  // NOTE on scale: `detectSignals` is called with whatever timeframe the
  // caller picked (currently 4h bars in the signals route). On 4h candles,
  // MA100 ≈ 17 days and MA300 ≈ 50 days — not the traditional 50d/200d
  // daily-chart cross. It still captures a medium-term trend shift; if we
  // later add a daily-timeframe pass alongside the 4h one we can compute
  // the "real" golden cross there and name the 4h version something else
  // (e.g. `trend_flip`) to avoid confusion with the well-known levels.
  if (ind.ma100[last] != null && ind.ma300[last] != null && ind.ma100[last - 1] != null && ind.ma300[last - 1] != null) {
    const prev = ind.ma100[last - 1]! - ind.ma300[last - 1]!;
    const curr = ind.ma100[last]! - ind.ma300[last]!;
    if (prev < 0 && curr >= 0) {
      const s = fire("golden_cross", "bullish", curr, "Golden Cross (MA100/300)");
      if (s) signals.push(tag(s));
    }
    if (prev > 0 && curr <= 0) {
      const s = fire("death_cross", "bearish", curr, "Death Cross (MA100/300)");
      if (s) signals.push(tag(s));
    }
  }

  return signals;
}

// ── Signal composition → conviction score ───────────────────────────────
// A confluence of aligned signals is what we actually want to trade on.
// Rather than emit a flurry of individual signals and hope the bot or UI
// aggregates them, we provide a single helper that turns a signal list for
// one symbol into a conviction score + summary. Weights reflect the relative
// information content of each signal family. RSI divergences and MACD
// crosses are worth more than a simple RSI level; breakouts more than a
// volume spike alone.
const FAMILY_WEIGHTS: Record<SignalFamily, number> = {
  momentum: 1.0,
  trend: 1.2,
  structure: 1.1,
  volume: 0.6,
  funding: 0.8,
  // Social signal carries weight comparable to momentum — mindshare
  // spikes lead price moves in crypto more often than they lag. The
  // edge is in *confluence* with TA, which the diversity bonus + the
  // cross-TF alignment bonus already amplify. Don't over-weight here
  // or single social-only fires would dominate the scorer.
  social: 0.9,
};

// Timeframe weights — longer timeframes carry more weight because they're
// less noisy and reflect bigger structural moves. `undefined` covers legacy
// signals that predate the timeframe field. `cross` is for cross-sectional
// signals (sector-RS) that aren't tied to a bar length but are still
// meaningful context.
const TIMEFRAME_WEIGHTS: Record<string, number> = {
  "1h": 0.6,
  "4h": 1.0,
  "1d": 1.5,
  cross: 0.8,
  undefined: 1.0,
};

// Per-type boosts layer on top of family weights. Divergences and
// long-timeframe crosses carry more predictive weight than level-based
// triggers, which tend to whipsaw in choppy markets.
const TYPE_WEIGHTS: Partial<Record<SignalType, number>> = {
  rsi_divergence_bullish: 1.8,
  rsi_divergence_bearish: 1.8,
  golden_cross: 1.5,
  death_cross: 1.5,
  breakout_up: 1.3,
  breakout_down: 1.3,
  // A real mindshare spike (≥50% Δ in mention count over 24h) is a
  // high-conviction setup — comparable to a price breakout. Weight
  // matches breakout_up/down so a TA-breakout + social-spike confluence
  // lands a heavy contribution to the conviction score.
  social_spike: 1.3,
};

export interface ConvictionResult {
  // Signed score: positive = bullish, negative = bearish. Magnitude is
  // roughly the weighted sum of contributing signals. A single strong
  // signal lands at ~1.5–2, a multi-family alignment at ~4+.
  score: number;
  label: "Strong Buy" | "Buy" | "Neutral" | "Sell" | "Strong Sell";
  bullishCount: number;
  bearishCount: number;
  contributingFamilies: SignalFamily[];
  volRegime: VolRegime;
  // Per-timeframe breakdown — null if no signals fired at that TF.
  byTimeframe: Partial<Record<Timeframe, { score: number; count: number }>>;
}

export function scoreConviction(
  signals: Signal[],
  // Sector-priority multiplier applied to the final score. Default 1
  // = no boost. Used by the alerter to amplify high-priority asset
  // classes (commodities = 1.4, stocks = 1.3, indices = 1.2 — see
  // sectors.ts SECTORS). Applied AFTER diversity + cross-TF bonuses
  // so the priority compounds with confluence rather than replacing
  // it. Resolver lives in sectors.ts to keep this lib sector-agnostic.
  sectorPriority: number = 1,
): ConvictionResult {
  let score = 0;
  const familySet = new Set<SignalFamily>();
  let bull = 0;
  let bear = 0;
  const byTf: Partial<Record<Timeframe, { score: number; count: number }>> = {};
  // Assume all signals in the list share a regime (they came from one
  // detectSignals call). If mixed, use the most recent.
  const volRegime: VolRegime =
    signals.length > 0 ? (signals[signals.length - 1].volRegime ?? "unknown") : "unknown";

  for (const s of signals) {
    const family = s.family ?? SIGNAL_FAMILY[s.type];
    const familyWeight = FAMILY_WEIGHTS[family] ?? 1;
    const typeWeight = TYPE_WEIGHTS[s.type] ?? 1;
    const tfKey = s.timeframe ?? "undefined";
    const tfWeight = TIMEFRAME_WEIGHTS[tfKey] ?? 1;
    // Normalize strength to [0.5, 1.5] so signals without an explicit
    // strength still contribute something reasonable.
    const intensity = s.strength != null ? 0.5 + s.strength / 100 : 1;
    const delta = familyWeight * typeWeight * intensity * tfWeight;
    const signed = s.direction === "bullish" ? delta : -delta;
    score += signed;
    if (s.direction === "bullish") bull += 1;
    else bear += 1;
    familySet.add(family);

    if (s.timeframe) {
      const entry = byTf[s.timeframe] ?? { score: 0, count: 0 };
      entry.score += signed;
      entry.count += 1;
      byTf[s.timeframe] = entry;
    }
  }

  // Diversity bonus: 3+ different families agreeing is stronger than the
  // same family firing three times. We multiply by a mild factor.
  if (familySet.size >= 3) score *= 1.15;

  // Cross-timeframe alignment bonus: when 1h/4h/1d agree in direction on a
  // per-timeframe basis, that's a much stronger setup than one timeframe
  // carrying the score alone. We add a small bonus proportional to how
  // many TFs align in the same direction as the net score.
  const tfScores = (["1h", "4h", "1d"] as Timeframe[])
    .map((t) => byTf[t]?.score ?? 0)
    .filter((x) => x !== 0);
  if (tfScores.length >= 2) {
    const netDir = Math.sign(score);
    const aligned = tfScores.filter((x) => Math.sign(x) === netDir).length;
    if (aligned >= 2) score *= 1 + 0.1 * (aligned - 1);
  }

  // Final step: sector-priority multiplier. Compounds with diversity +
  // cross-TF bonuses so a commodity setup that already had confluence
  // gets the boost it deserves; a single-signal commodity move at
  // baseline conviction still won't cross the Strong Buy threshold.
  if (sectorPriority !== 1) score *= sectorPriority;

  let label: ConvictionResult["label"];
  if (score >= 3.5) label = "Strong Buy";
  else if (score >= 1.5) label = "Buy";
  else if (score <= -3.5) label = "Strong Sell";
  else if (score <= -1.5) label = "Sell";
  else label = "Neutral";

  return {
    score: Math.round(score * 100) / 100,
    label,
    bullishCount: bull,
    bearishCount: bear,
    contributingFamilies: [...familySet],
    volRegime,
    byTimeframe: byTf,
  };
}

// ── Sector-relative strength ────────────────────────────────────────────
// Given a snapshot of (symbol, sector, change%) tuples across the universe,
// emit signals for assets that are significantly outperforming or
// underperforming their sector median. This is the piece that turns
// "L1 sector +1.2% with SOL +4.8%" into a concrete "SOL sector-leader"
// trade idea.
//
// Design notes:
// - Z-score against the sector's cross-section, not absolute deviation —
//   a 1% gap matters more when the sector is tight than when it's wide.
// - Minimum 4 symbols per sector before we'll compute — otherwise a single
//   outlier would dominate its own median.
// - Directional: "leader" = above median, "laggard" = below. We don't
//   encode bullish/bearish because interpretation depends on the user's
//   strategy (breakout traders long leaders; mean-reversion traders fade
//   leaders / buy laggards). We emit both flavors and let the bot's
//   strategy rules decide.
// - The legacy single-arg signature (24h-only) is preserved so existing
//   callers keep working unchanged. The horizon-aware multi-arg signature
//   accepts a richer snapshot shape and emits per-horizon signals tagged
//   with the corresponding timeframe.
export interface SectorSnapshot {
  symbol: string;
  sector: Sector;
  change24h: number | null;
}

// Horizon-keyed change shape — used by the multi-arg sector-RS pass.
// Any horizon may be null; we skip the horizon for that symbol but still
// rank the symbol on the horizons that do have data.
export interface SectorMultiSnapshot {
  symbol: string;
  sector: Sector;
  change1h?: number | null;
  change4h?: number | null;
  change24h?: number | null;
}

export type SectorHorizon = "1h" | "4h" | "24h";

const SECTOR_RS_MIN_MEMBERS = 4;
const SECTOR_RS_Z_THRESHOLD = 1.5; // ≈ top/bottom ~7% by Z-score

// Horizon → timeframe tag mapping. 24h sector RS lives at the daily
// timeframe; 4h at the 4h scan; 1h at the 1h scan. This lets the
// conviction scorer reuse the timeframe-alignment bonus naturally.
const HORIZON_TF: Record<SectorHorizon, Timeframe> = {
  "1h": "1h",
  "4h": "4h",
  "24h": "1d",
};

function rankSectorHorizon(
  members: Array<{ symbol: string; change: number }>,
  sector: Sector,
  horizon: SectorHorizon,
  firedAt: number
): Signal[] {
  if (members.length < SECTOR_RS_MIN_MEMBERS) return [];

  // Median + MAD (median absolute deviation) — robust vs outlier-dragged
  // mean/stddev, which matters when one coin pumps 40% and distorts the
  // sector stats we're trying to measure deviation against.
  const sorted = [...members].sort((a, b) => a.change - b.change);
  const median = sorted[Math.floor(sorted.length / 2)].change;
  const absDevs = members.map((m) => Math.abs(m.change - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)] || 0.0001;
  // 1.4826 scales MAD to an estimate of σ for a normal distribution.
  const sigma = mad * 1.4826;
  const tf = HORIZON_TF[horizon];

  const out: Signal[] = [];
  for (const m of members) {
    const z = (m.change - median) / sigma;
    if (z >= SECTOR_RS_Z_THRESHOLD) {
      out.push({
        symbol: m.symbol,
        type: "sector_leader",
        family: "structure",
        direction: "bullish",
        value: z,
        strength: Math.min(100, ((z - SECTOR_RS_Z_THRESHOLD) / 2) * 80 + 40),
        label: `Sector leader in ${sector} (${horizon}): ${m.change.toFixed(1)}% vs median ${median.toFixed(1)}% (z=${z.toFixed(1)})`,
        firedAt,
        timeframe: tf,
      });
    } else if (z <= -SECTOR_RS_Z_THRESHOLD) {
      out.push({
        symbol: m.symbol,
        type: "sector_laggard",
        family: "structure",
        direction: "bearish",
        value: z,
        strength: Math.min(100, ((Math.abs(z) - SECTOR_RS_Z_THRESHOLD) / 2) * 80 + 40),
        label: `Sector laggard in ${sector} (${horizon}): ${m.change.toFixed(1)}% vs median ${median.toFixed(1)}% (z=${z.toFixed(1)})`,
        firedAt,
        timeframe: tf,
      });
    }
  }
  return out;
}

export function detectSectorRelativeStrength(
  snapshot: SectorSnapshot[]
): Signal[] {
  const bySector = new Map<Sector, { symbol: string; change: number }[]>();
  for (const s of snapshot) {
    if (s.change24h == null || !Number.isFinite(s.change24h)) continue;
    const list = bySector.get(s.sector) ?? [];
    list.push({ symbol: s.symbol, change: s.change24h });
    bySector.set(s.sector, list);
  }

  const now = Date.now();
  const signals: Signal[] = [];
  for (const [sector, members] of bySector) {
    signals.push(...rankSectorHorizon(members, sector, "24h", now));
  }
  // Legacy callers expect the 24h pass without the timeframe tag (so the
  // old conviction bookkeeping that treats "cross" specially isn't
  // accidentally activated). Strip the timeframe for backward-compat.
  return signals.map((s) => {
    const { timeframe, ...rest } = s;
    void timeframe;
    return rest;
  });
}

// ── Social-mindshare spike ──────────────────────────────────────────────
// Given a snapshot of (symbol, mention_count, prev_count, change_pct)
// tuples from Elfa, emit a `social_spike` signal for each symbol with a
// genuine spike in attention. We need both criteria to fire:
//
//   1. change_pct ≥ SOCIAL_SPIKE_PCT (default 50%). A 50% Δ over 24h is
//      meaningful but not extreme — extreme spikes (200%+) get the full
//      strength score via the linear interpolation below.
//   2. mention_count ≥ SOCIAL_SPIKE_MIN_COUNT (default 100). Filters out
//      tiny-volume tickers that doubled from 8 → 16 mentions, which is
//      noise dressed as signal.
//
// Direction: bullish by default. Elfa's trending-tokens endpoint doesn't
// expose sentiment, only counts — and in crypto, raw attention is more
// often coincident with rallies than dumps. The scorer doesn't lean
// hard on direction for social_spike anyway (it acts more like
// volume_spike — sets the stage, the direction comes from accompanying
// TA signals). Future work: switch to data/keyword-mentions and read
// sentiment polarity to emit a bearish flavor when warranted.
export interface SocialSnapshot {
  symbol: string;            // UPPERCASE
  mention_count: number;
  prev_count: number | null;
  change_pct: number | null;
}

const SOCIAL_SPIKE_PCT = 50;
const SOCIAL_SPIKE_MIN_COUNT = 100;

export function detectSocialSpike(snapshot: SocialSnapshot[]): Signal[] {
  const now = Date.now();
  const out: Signal[] = [];
  for (const s of snapshot) {
    if (s.change_pct == null || !Number.isFinite(s.change_pct)) continue;
    if (s.mention_count < SOCIAL_SPIKE_MIN_COUNT) continue;
    if (s.change_pct < SOCIAL_SPIKE_PCT) continue;

    // Strength: linearly scale 50% → 40, 200%+ → 100. Caps protect
    // against the rare ticker that 10×s its mention count overnight.
    const strength = Math.min(
      100,
      40 + ((s.change_pct - SOCIAL_SPIKE_PCT) / 150) * 60
    );
    out.push({
      symbol: s.symbol,
      type: "social_spike",
      family: "social",
      direction: "bullish",
      value: s.change_pct,
      strength,
      label: `Mindshare spike: ${s.mention_count} mentions (+${s.change_pct.toFixed(0)}% 24h)`,
      firedAt: now,
      // Tagged "cross" because mindshare is a cross-sectional signal
      // not tied to a candle timeframe. Mirrors sector_leader / laggard
      // and lands in the TIMEFRAME_WEIGHTS["cross"] (0.8) bucket.
      timeframe: "cross",
    });
  }
  return out;
}

// Multi-horizon variant — ranks each sector on every available horizon
// (1h / 4h / 24h) and emits a signal per (symbol, horizon) outlier.
// Caller is responsible for assembling the SectorMultiSnapshot list,
// typically by joining the live HL ctx (24h, via prevDayPx) with the
// snapshotAt() lookup table for 1h-ago and 4h-ago marks.
export function detectSectorRelativeStrengthMulti(
  snapshot: SectorMultiSnapshot[]
): Signal[] {
  const byHorizon: Record<SectorHorizon, Map<Sector, Array<{ symbol: string; change: number }>>> = {
    "1h": new Map(),
    "4h": new Map(),
    "24h": new Map(),
  };

  for (const s of snapshot) {
    const fields: Array<{ h: SectorHorizon; v: number | null | undefined }> = [
      { h: "1h", v: s.change1h },
      { h: "4h", v: s.change4h },
      { h: "24h", v: s.change24h },
    ];
    for (const { h, v } of fields) {
      if (v == null || !Number.isFinite(v)) continue;
      const m = byHorizon[h].get(s.sector) ?? [];
      m.push({ symbol: s.symbol, change: v });
      byHorizon[h].set(s.sector, m);
    }
  }

  const now = Date.now();
  const out: Signal[] = [];
  for (const horizon of Object.keys(byHorizon) as SectorHorizon[]) {
    for (const [sector, members] of byHorizon[horizon]) {
      out.push(...rankSectorHorizon(members, sector, horizon, now));
    }
  }
  return out;
}

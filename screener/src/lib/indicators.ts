export function sma(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

export function ema(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);
  let sum = 0;

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      sum += data[i];
      result.push(null);
    } else if (i === period - 1) {
      sum += data[i];
      result.push(sum / period);
    } else {
      const prev = result[i - 1]!;
      result.push(data[i] * k + prev * (1 - k));
    }
  }
  return result;
}

export function rsi(closes: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [];
  if (closes.length < period + 1) return closes.map(() => null);

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = 0; i <= period; i++) {
    result.push(
      i === period
        ? avgLoss === 0
          ? 100
          : 100 - 100 / (1 + avgGain / avgLoss)
        : null
    );
  }

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return result;
}

export interface MACDResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(
  closes: number[],
  fast: number = 12,
  slow: number = 26,
  sig: number = 9
): MACDResult {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) {
      macdLine.push(emaFast[i]! - emaSlow[i]!);
    } else {
      macdLine.push(null);
    }
  }

  const nonNullStart = macdLine.findIndex((v) => v !== null);
  if (nonNullStart === -1) {
    return { macd: macdLine, signal: macdLine.map(() => null), histogram: macdLine.map(() => null) };
  }

  const macdValues = macdLine.slice(nonNullStart).map((v) => v!);
  const signalValues = ema(macdValues, sig);

  const signal: (number | null)[] = new Array(nonNullStart).fill(null);
  signal.push(...signalValues);

  const histogram: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null && i < signal.length && signal[i] !== null) {
      histogram.push(macdLine[i]! - signal[i]!);
    } else {
      histogram.push(null);
    }
  }

  return { macd: macdLine, signal, histogram };
}

export interface IndicatorSeries {
  rsi: (number | null)[];
  macd: MACDResult;
  ema13: (number | null)[];
  ema25: (number | null)[];
  ema32: (number | null)[];
  ma100: (number | null)[];
  ma300: (number | null)[];
  ema200: (number | null)[];
}

export function computeAllIndicators(closes: number[]): IndicatorSeries {
  return {
    rsi: rsi(closes),
    macd: macd(closes),
    ema13: ema(closes, 13),
    ema25: ema(closes, 25),
    ema32: ema(closes, 32),
    ma100: sma(closes, 100),
    ma300: sma(closes, 300),
    ema200: ema(closes, 200),
  };
}

// ── ATR (Average True Range) ─────────────────────────────────────────────
// True range of bar i = max(high−low, |high−prevClose|, |low−prevClose|).
// ATR is the Wilder-smoothed mean of TR over `period` bars. We return ATR as
// a **percentage of the current close** so thresholds are cross-asset
// comparable (otherwise ATR on BTC and SHIB aren't on the same scale).
export function atrPercent(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14
): (number | null)[] {
  const n = Math.min(highs.length, lows.length, closes.length);
  const trueRanges: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      trueRanges.push(highs[i] - lows[i]);
    } else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      trueRanges.push(Math.max(hl, hc, lc));
    }
  }

  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period) return out;

  // Seed with SMA of first `period` TRs, then Wilder-smooth.
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = closes[period - 1] > 0 ? (atr / closes[period - 1]) * 100 : null;
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    out[i] = closes[i] > 0 ? (atr / closes[i]) * 100 : null;
  }
  return out;
}

// Volatility regime tag derived from a rolling ATR% distribution for a given
// symbol. `currentAtrPct` is today's ATR% (typically the last value of the
// atrPercent series); `historicalAtrPct` is the prior window against which
// we rank it. Regime buckets:
//   quiet  – bottom 25% of historical ATR% (mean-reversion tends to work)
//   normal – 25–75%
//   wild   – top 25% (breakouts & momentum more reliable; RSI levels noisier)
// If history is too short we return "unknown" so callers can gate.
export type VolRegime = "quiet" | "normal" | "wild" | "unknown";

export function classifyVolRegime(
  currentAtrPct: number | null,
  historicalAtrPct: (number | null)[],
  minSamples: number = 30
): VolRegime {
  if (currentAtrPct == null) return "unknown";
  const clean = historicalAtrPct.filter(
    (x): x is number => x != null && Number.isFinite(x)
  );
  if (clean.length < minSamples) return "unknown";
  const sorted = [...clean].sort((a, b) => a - b);
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  if (currentAtrPct < p25) return "quiet";
  if (currentAtrPct > p75) return "wild";
  return "normal";
}

// ── Pivot detection ──────────────────────────────────────────────────────
// Local minima / maxima in a series. A pivot at index i is a value that is
// ≤ (or ≥) both neighbours. `minGap` enforces spacing between pivots so we
// don't count noisy plateau points as separate pivots.
function findPivots(
  series: (number | null)[],
  type: "low" | "high",
  minGap: number = 3
): number[] {
  const pivots: number[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    const a = series[i - 1];
    const b = series[i];
    const c = series[i + 1];
    if (a == null || b == null || c == null) continue;
    const isLow = type === "low" && b <= a && b <= c;
    const isHigh = type === "high" && b >= a && b >= c;
    if (isLow || isHigh) {
      if (pivots.length === 0 || i - pivots[pivots.length - 1] >= minGap) {
        pivots.push(i);
      }
    }
  }
  return pivots;
}

export interface DivergenceResult {
  bullish: boolean;
  bearish: boolean;
  description: string | null;
}

// ── RSI divergence detection ─────────────────────────────────────────────
// - Bullish divergence: price makes a lower low but RSI makes a higher low.
//   Interpretation: sellers pushed price lower but momentum couldn't confirm
//   — often an early exhaustion signal. Weighted heavier than a plain RSI
//   level in the confluence scorer.
// - Bearish divergence: mirror of the above on highs.
//
// We look at the last `lookback` candles, find the two most recent pivots of
// the appropriate type in price, and check whether the matching RSI values
// diverge. Short-term noise is filtered by `minGap` (3 bars between pivots).
export function detectDivergences(
  closes: number[],
  rsiValues: (number | null)[],
  lookback: number = 30
): DivergenceResult {
  if (closes.length < 5 || rsiValues.length < 5) {
    return { bullish: false, bearish: false, description: null };
  }

  const len = Math.min(closes.length, rsiValues.length, lookback);
  const priceWindow = closes.slice(-len);
  const rsiWindow = rsiValues.slice(-len);

  let bullishDivergence = false;
  let bearishDivergence = false;
  const descriptions: string[] = [];

  const priceLows = findPivots(priceWindow, "low", 3);
  if (priceLows.length >= 2) {
    const prev = priceLows[priceLows.length - 2];
    const curr = priceLows[priceLows.length - 1];
    const rsiPrev = rsiWindow[prev];
    const rsiCurr = rsiWindow[curr];
    if (
      rsiPrev != null &&
      rsiCurr != null &&
      priceWindow[curr] < priceWindow[prev] &&
      rsiCurr > rsiPrev
    ) {
      bullishDivergence = true;
      descriptions.push(
        `Bullish divergence over ${curr - prev} bars (price ${priceWindow[prev].toFixed(2)}→${priceWindow[curr].toFixed(2)}, RSI ${rsiPrev.toFixed(1)}→${rsiCurr.toFixed(1)})`
      );
    }
  }

  const priceHighs = findPivots(priceWindow, "high", 3);
  if (priceHighs.length >= 2) {
    const prev = priceHighs[priceHighs.length - 2];
    const curr = priceHighs[priceHighs.length - 1];
    const rsiPrev = rsiWindow[prev];
    const rsiCurr = rsiWindow[curr];
    if (
      rsiPrev != null &&
      rsiCurr != null &&
      priceWindow[curr] > priceWindow[prev] &&
      rsiCurr < rsiPrev
    ) {
      bearishDivergence = true;
      descriptions.push(
        `Bearish divergence over ${curr - prev} bars (price ${priceWindow[prev].toFixed(2)}→${priceWindow[curr].toFixed(2)}, RSI ${rsiPrev.toFixed(1)}→${rsiCurr.toFixed(1)})`
      );
    }
  }

  return {
    bullish: bullishDivergence,
    bearish: bearishDivergence,
    description: descriptions.length > 0 ? descriptions.join("; ") : null,
  };
}

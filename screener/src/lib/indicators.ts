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

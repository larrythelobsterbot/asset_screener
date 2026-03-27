import { computeAllIndicators } from "./indicators";

export type SignalType =
  | "rsi_overbought"
  | "rsi_oversold"
  | "macd_bullish"
  | "macd_bearish"
  | "volume_spike"
  | "breakout_up"
  | "breakout_down"
  | "funding_anomaly"
  | "ema_bullish"
  | "ema_bearish"
  | "golden_cross"
  | "death_cross";

export type SignalDirection = "bullish" | "bearish";

export interface Signal {
  symbol: string;
  type: SignalType;
  direction: SignalDirection;
  value: number;
  label: string;
  firedAt: number;
}

const eventHistory = new Map<string, number>();

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
  label: string
): Signal | null {
  const key = `${symbol}:${type}`;
  const now = Date.now();
  const lastFired = eventHistory.get(key);
  const persist = PERSISTENCE[type] || 24 * 3_600_000;
  if (lastFired && now - lastFired < persist) return null;
  eventHistory.set(key, now);
  return { symbol, type, direction, value, label, firedAt: now };
}

export function detectSignals(
  symbol: string,
  closes: number[],
  volumes: number[],
  highs: number[],
  lows: number[],
  fundingRate?: number
): Signal[] {
  if (closes.length < 30) return [];

  const signals: Signal[] = [];
  const ind = computeAllIndicators(closes);
  const last = closes.length - 1;

  // RSI
  const rsiVal = ind.rsi[last];
  if (rsiVal !== null) {
    if (rsiVal > 70) {
      signals.push({ symbol, type: "rsi_overbought", direction: "bearish", value: rsiVal, label: `RSI Overbought (${rsiVal.toFixed(1)})`, firedAt: Date.now() });
    }
    if (rsiVal < 30) {
      signals.push({ symbol, type: "rsi_oversold", direction: "bullish", value: rsiVal, label: `RSI Oversold (${rsiVal.toFixed(1)})`, firedAt: Date.now() });
    }
  }

  // MACD crossover
  const m = ind.macd;
  if (m.macd[last] != null && m.signal[last] != null && m.macd[last - 1] != null && m.signal[last - 1] != null) {
    const prev = m.macd[last - 1]! - m.signal[last - 1]!;
    const curr = m.macd[last]! - m.signal[last]!;
    if (prev < 0 && curr >= 0) {
      const s = fireEvent(symbol, "macd_bullish", "bullish", curr, "MACD Bullish Cross");
      if (s) signals.push(s);
    }
    if (prev > 0 && curr <= 0) {
      const s = fireEvent(symbol, "macd_bearish", "bearish", curr, "MACD Bearish Cross");
      if (s) signals.push(s);
    }
  }

  // Volume spike
  if (volumes.length >= 21) {
    const avg = volumes.slice(last - 20, last).reduce((a, b) => a + b, 0) / 20;
    if (avg > 0 && volumes[last] > 2 * avg) {
      signals.push({ symbol, type: "volume_spike", direction: "bullish", value: volumes[last] / avg, label: `Volume Spike (${(volumes[last] / avg).toFixed(1)}x)`, firedAt: Date.now() });
    }
  }

  // Price breakout
  if (highs.length >= 21) {
    const highest = Math.max(...highs.slice(last - 20, last));
    const lowest = Math.min(...lows.slice(last - 20, last));
    if (closes[last] > highest) {
      const s = fireEvent(symbol, "breakout_up", "bullish", closes[last], `Breakout Up`);
      if (s) signals.push(s);
    }
    if (closes[last] < lowest) {
      const s = fireEvent(symbol, "breakout_down", "bearish", closes[last], `Breakout Down`);
      if (s) signals.push(s);
    }
  }

  // Funding rate anomaly
  if (fundingRate !== undefined && Math.abs(fundingRate) > 0.0001) {
    signals.push({
      symbol, type: "funding_anomaly",
      direction: fundingRate > 0 ? "bearish" : "bullish",
      value: fundingRate,
      label: `Funding ${fundingRate > 0 ? "High" : "Negative"} (${(fundingRate * 100).toFixed(4)}%)`,
      firedAt: Date.now(),
    });
  }

  // EMA 13/25 crossover
  if (ind.ema13[last] != null && ind.ema25[last] != null && ind.ema13[last - 1] != null && ind.ema25[last - 1] != null) {
    const prev = ind.ema13[last - 1]! - ind.ema25[last - 1]!;
    const curr = ind.ema13[last]! - ind.ema25[last]!;
    if (prev < 0 && curr >= 0) {
      const s = fireEvent(symbol, "ema_bullish", "bullish", curr, "EMA 13/25 Bullish Cross");
      if (s) signals.push(s);
    }
    if (prev > 0 && curr <= 0) {
      const s = fireEvent(symbol, "ema_bearish", "bearish", curr, "EMA 13/25 Bearish Cross");
      if (s) signals.push(s);
    }
  }

  // Golden/Death Cross: MA100 vs MA300
  if (ind.ma100[last] != null && ind.ma300[last] != null && ind.ma100[last - 1] != null && ind.ma300[last - 1] != null) {
    const prev = ind.ma100[last - 1]! - ind.ma300[last - 1]!;
    const curr = ind.ma100[last]! - ind.ma300[last]!;
    if (prev < 0 && curr >= 0) {
      const s = fireEvent(symbol, "golden_cross", "bullish", curr, "Golden Cross");
      if (s) signals.push(s);
    }
    if (prev > 0 && curr <= 0) {
      const s = fireEvent(symbol, "death_cross", "bearish", curr, "Death Cross");
      if (s) signals.push(s);
    }
  }

  return signals;
}

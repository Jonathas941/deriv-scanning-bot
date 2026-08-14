import type { Candle } from '../deriv/types';

/**
 * Simple moving average of the last `period` values.
 * Returns null when there is not enough data — callers must handle null rather
 * than receive a silently wrong number.
 */
export function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i];
  return sum / period;
}

/**
 * Exponential moving average series. Seeded with an SMA of the first `period`
 * values, which is the conventional warm-up and avoids the early-bar distortion
 * you get from seeding with the first price.
 *
 * Returns a series aligned to the input: index i holds the EMA as of values[i],
 * with `null` for indices before the seed completes.
 */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series[series.length - 1] ?? null;
}

/**
 * Wilder's RSI. Uses Wilder smoothing (not a plain average) so values match
 * what charting platforms display.
 */
export function rsi(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  // A run with no downside is RSI 100 by definition; guard the divide.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** True Range for candle i (requires the previous close). */
function trueRange(current: Candle, previousClose: number): number {
  return Math.max(
    current.high - current.low,
    Math.abs(current.high - previousClose),
    Math.abs(current.low - previousClose),
  );
}

/** Wilder's Average True Range. */
export function atr(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period + 1) return null;

  let sum = 0;
  for (let i = 1; i <= period; i += 1) {
    sum += trueRange(candles[i], candles[i - 1].close);
  }
  let value = sum / period;

  for (let i = period + 1; i < candles.length; i += 1) {
    const tr = trueRange(candles[i], candles[i - 1].close);
    value = (value * (period - 1) + tr) / period;
  }
  return value;
}

/** Standard deviation of the last `period` values (population). */
export function stddev(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
}

export interface SwingPoints {
  high: number;
  low: number;
  highIndex: number;
  lowIndex: number;
}

/** Highest high and lowest low over the last `lookback` candles. */
export function swings(candles: Candle[], lookback: number): SwingPoints | null {
  if (candles.length < lookback || lookback <= 0) return null;
  const start = candles.length - lookback;
  let high = -Infinity;
  let low = Infinity;
  let highIndex = start;
  let lowIndex = start;
  for (let i = start; i < candles.length; i += 1) {
    if (candles[i].high > high) {
      high = candles[i].high;
      highIndex = i;
    }
    if (candles[i].low < low) {
      low = candles[i].low;
      lowIndex = i;
    }
  }
  return { high, low, highIndex, lowIndex };
}

export type CandleShape = 'bullish' | 'bearish' | 'doji';

export interface CandleAnatomy {
  shape: CandleShape;
  bodyRatio: number; // body size as a fraction of full range
  upperWickRatio: number;
  lowerWickRatio: number;
}

/** Decomposes a candle into body/wick proportions for structure scoring. */
export function anatomy(c: Candle): CandleAnatomy {
  const range = c.high - c.low;
  if (range <= 0) {
    return { shape: 'doji', bodyRatio: 0, upperWickRatio: 0, lowerWickRatio: 0 };
  }
  const body = Math.abs(c.close - c.open);
  const bodyRatio = body / range;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  let shape: CandleShape = 'doji';
  if (bodyRatio >= 0.1) shape = c.close > c.open ? 'bullish' : 'bearish';

  return {
    shape,
    bodyRatio,
    upperWickRatio: upper / range,
    lowerWickRatio: lower / range,
  };
}

/** True when `current` engulfs `previous` in the given direction. */
export function isEngulfing(previous: Candle, current: Candle, direction: 'up' | 'down'): boolean {
  const prevBodyHigh = Math.max(previous.open, previous.close);
  const prevBodyLow = Math.min(previous.open, previous.close);
  if (direction === 'up') {
    return current.close > current.open && current.close >= prevBodyHigh && current.open <= prevBodyLow;
  }
  return current.close < current.open && current.open >= prevBodyHigh && current.close <= prevBodyLow;
}

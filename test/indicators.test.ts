import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  anatomy,
  atr,
  ema,
  emaSeries,
  isEngulfing,
  rsi,
  sma,
  stddev,
  swings,
} from '../src/indicators';
import type { Candle } from '../src/deriv/types';

function candle(o: number, h: number, l: number, c: number, epoch = 0): Candle {
  return { open: o, high: h, low: l, close: c, epoch };
}

describe('sma', () => {
  it('averages the last N values', () => {
    assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
    assert.equal(sma([1, 2, 3, 4, 5], 2), 4.5);
  });

  it('returns null when there is not enough data', () => {
    assert.equal(sma([1, 2], 5), null);
    assert.equal(sma([], 1), null);
  });

  it('rejects a non-positive period rather than dividing by zero', () => {
    assert.equal(sma([1, 2, 3], 0), null);
  });
});

describe('emaSeries', () => {
  it('seeds with an SMA at index period-1', () => {
    const values = [1, 2, 3, 4, 5, 6];
    const series = emaSeries(values, 3);
    assert.equal(series[0], null);
    assert.equal(series[1], null);
    assert.equal(series[2], 2); // SMA of 1,2,3
  });

  it('tracks a constant series exactly', () => {
    const flat = new Array(50).fill(10) as number[];
    assert.equal(ema(flat, 10), 10);
  });

  it('lags a rising series below the latest price', () => {
    const rising = Array.from({ length: 60 }, (_, i) => i + 1);
    const value = ema(rising, 10)!;
    assert.ok(value < 60, 'EMA should trail the newest value in an uptrend');
    assert.ok(value > 50, `EMA should stay close behind, got ${value}`);
  });

  it('reacts faster with a shorter period', () => {
    const rising = Array.from({ length: 60 }, (_, i) => i + 1);
    assert.ok(ema(rising, 5)! > ema(rising, 20)!);
  });

  it('returns all nulls when shorter than the period', () => {
    assert.deepEqual(emaSeries([1, 2], 5), [null, null]);
  });
});

describe('rsi', () => {
  it('returns 100 for an unbroken advance', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    assert.equal(rsi(up, 14), 100);
  });

  it('returns a low value for an unbroken decline', () => {
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    const value = rsi(down, 14)!;
    assert.ok(value < 5, `expected deeply oversold, got ${value}`);
  });

  it('returns 50 for a flat series rather than dividing by zero', () => {
    const flat = new Array(40).fill(100) as number[];
    assert.equal(rsi(flat, 14), 50);
  });

  it('stays inside 0..100 on noisy data', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 5 + (i % 7));
    const value = rsi(noisy, 14)!;
    assert.ok(value >= 0 && value <= 100, `RSI escaped its band: ${value}`);
  });

  it('needs period+1 values', () => {
    assert.equal(rsi([1, 2, 3], 14), null);
  });
});

describe('atr', () => {
  it('equals the bar range when every bar is identical and gapless', () => {
    const candles: Candle[] = Array.from({ length: 30 }, () => candle(10, 11, 9, 10));
    const value = atr(candles, 14)!;
    assert.ok(Math.abs(value - 2) < 1e-9, `expected 2, got ${value}`);
  });

  it('accounts for gaps via true range', () => {
    const candles: Candle[] = [
      ...Array.from({ length: 20 }, () => candle(10, 10.5, 9.5, 10)),
      candle(20, 20.5, 19.5, 20), // large gap up
    ];
    const withGap = atr(candles, 14)!;
    const withoutGap = atr(candles.slice(0, 20), 14)!;
    assert.ok(withGap > withoutGap, 'a gap must raise ATR');
  });

  it('returns null without enough candles', () => {
    assert.equal(atr([candle(1, 2, 0, 1)], 14), null);
  });
});

describe('stddev', () => {
  it('is zero for a constant series', () => {
    assert.equal(stddev([5, 5, 5, 5], 4), 0);
  });

  it('is positive for a varying series', () => {
    assert.ok(stddev([1, 2, 3, 4], 4)! > 0);
  });
});

describe('swings', () => {
  it('finds the extreme high and low in the lookback window', () => {
    const candles = [
      candle(1, 5, 0, 2),
      candle(2, 9, 1, 3),
      candle(3, 6, -2, 4),
    ];
    const s = swings(candles, 3)!;
    assert.equal(s.high, 9);
    assert.equal(s.low, -2);
    assert.equal(s.highIndex, 1);
    assert.equal(s.lowIndex, 2);
  });

  it('returns null when the window exceeds available data', () => {
    assert.equal(swings([candle(1, 2, 0, 1)], 5), null);
  });
});

describe('anatomy', () => {
  it('classifies a strong bullish candle', () => {
    const a = anatomy(candle(10, 12, 9.9, 11.9));
    assert.equal(a.shape, 'bullish');
    assert.ok(a.bodyRatio > 0.8);
  });

  it('classifies a doji by tiny body ratio', () => {
    const a = anatomy(candle(10, 11, 9, 10.02));
    assert.equal(a.shape, 'doji');
  });

  it('handles a zero-range candle without dividing by zero', () => {
    const a = anatomy(candle(10, 10, 10, 10));
    assert.equal(a.shape, 'doji');
    assert.equal(a.bodyRatio, 0);
    assert.ok(Number.isFinite(a.upperWickRatio));
  });

  it('measures wicks as a fraction of range', () => {
    // range 10..20, body 12..14 → lower wick 2/10, upper wick 6/10
    const a = anatomy(candle(12, 20, 10, 14));
    assert.ok(Math.abs(a.lowerWickRatio - 0.2) < 1e-9);
    assert.ok(Math.abs(a.upperWickRatio - 0.6) < 1e-9);
  });
});

describe('isEngulfing', () => {
  it('detects a bullish engulfing', () => {
    const prev = candle(10, 10.5, 9.5, 9.6);
    const cur = candle(9.5, 11, 9.4, 10.5);
    assert.equal(isEngulfing(prev, cur, 'up'), true);
  });

  it('rejects the wrong direction', () => {
    const prev = candle(10, 10.5, 9.5, 9.6);
    const cur = candle(9.5, 11, 9.4, 10.5);
    assert.equal(isEngulfing(prev, cur, 'down'), false);
  });

  it('rejects a body that does not fully cover the previous body', () => {
    const prev = candle(10, 10.5, 9.5, 9.6);
    const cur = candle(9.8, 10.2, 9.7, 9.9);
    assert.equal(isEngulfing(prev, cur, 'up'), false);
  });
});

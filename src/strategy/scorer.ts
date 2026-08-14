import type { Config } from '../config';
import type { Candle, Direction } from '../deriv/types';
import { anatomy, atr, emaSeries, isEngulfing, rsi, stddev } from '../indicators';

export interface ScoreComponent {
  name: string;
  earned: number;
  max: number;
  note: string;
}

export interface Signal {
  symbol: string;
  displayName: string;
  direction: Direction;
  score: number;
  components: ScoreComponent[];
  price: number;
  atr: number;
  atrPercent: number;
  rsi: number;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  candleEpoch: number;
  evaluatedAt: string;
}

export interface Rejection {
  symbol: string;
  reason: string;
}

export type Evaluation =
  | { ok: true; signal: Signal }
  | { ok: false; rejection: Rejection };

/**
 * Weights sum to 100. Kept explicit so the dashboard can show how a score
 * was built rather than presenting an unexplained number.
 */
const WEIGHTS = {
  trend: 30,
  momentum: 20,
  location: 20,
  structure: 20,
  volatility: 10,
} as const;

/** Clamp helper — scores must never escape their band. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Scores a symbol's candle history into a 0-100 confluence signal.
 *
 * The model is deliberately conservative: direction is decided by the trend
 * stack first, and every other component can only *confirm* that direction.
 * A component that disagrees earns zero rather than flipping the trade.
 */
export function evaluate(
  symbol: string,
  displayName: string,
  candles: Candle[],
  cfg: Config,
): Evaluation {
  const minBars = cfg.emaTrend + cfg.atrPeriod + 10;
  if (candles.length < minBars) {
    return {
      ok: false,
      rejection: { symbol, reason: `insufficient history (${candles.length}/${minBars} bars)` },
    };
  }

  // The final candle from Deriv is the still-forming one. Drop it so we never
  // score a partial bar that can repaint before it closes.
  const closed = candles.slice(0, -1);
  if (closed.length < minBars) {
    return {
      ok: false,
      rejection: { symbol, reason: 'insufficient closed bars after dropping forming candle' },
    };
  }

  const closes = closed.map((c) => c.close);
  const last = closed[closed.length - 1];
  const prev = closed[closed.length - 2];

  const fastSeries = emaSeries(closes, cfg.emaFast);
  const slowSeries = emaSeries(closes, cfg.emaSlow);
  const trendSeries = emaSeries(closes, cfg.emaTrend);

  const fast = fastSeries[fastSeries.length - 1];
  const slow = slowSeries[slowSeries.length - 1];
  const trend = trendSeries[trendSeries.length - 1];
  const trendPrev = trendSeries[trendSeries.length - 6] ?? null;

  const rsiValue = rsi(closes, cfg.rsiPeriod);
  const atrValue = atr(closed, cfg.atrPeriod);

  if (fast === null || slow === null || trend === null || rsiValue === null || atrValue === null) {
    return { ok: false, rejection: { symbol, reason: 'indicator warm-up incomplete' } };
  }
  if (atrValue <= 0 || last.close <= 0) {
    return { ok: false, rejection: { symbol, reason: 'degenerate price or zero volatility' } };
  }

  const price = last.close;
  const atrPercent = (atrValue / price) * 100;

  // ---------------------------------------------------------------------
  // Direction: the trend stack decides. No stack, no trade.
  // ---------------------------------------------------------------------
  const bullStack = fast > slow && slow > trend && price > trend;
  const bearStack = fast < slow && slow < trend && price < trend;

  if (!bullStack && !bearStack) {
    return { ok: false, rejection: { symbol, reason: 'no clean EMA trend stack (ranging)' } };
  }
  const direction: Direction = bullStack ? 'CALL' : 'PUT';
  const isBull = direction === 'CALL';

  const components: ScoreComponent[] = [];

  // ---------------------------------------------------------------------
  // 1. Trend quality (30) — separation between EMAs plus trend-EMA slope.
  // ---------------------------------------------------------------------
  {
    const separation = Math.abs(fast - slow) / atrValue; // in ATR units
    const separationScore = clamp(separation / 1.0, 0, 1) * (WEIGHTS.trend * 0.6);

    let slopeScore = 0;
    let slopeNote = 'slope unavailable';
    if (trendPrev !== null) {
      const slope = (trend - trendPrev) / atrValue;
      const aligned = isBull ? slope : -slope;
      slopeScore = clamp(aligned / 0.5, 0, 1) * (WEIGHTS.trend * 0.4);
      slopeNote = `trend EMA slope ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} ATR/5bars`;
    }

    const earned = separationScore + slopeScore;
    components.push({
      name: 'trend',
      earned: Number(earned.toFixed(2)),
      max: WEIGHTS.trend,
      note: `EMA separation ${separation.toFixed(2)} ATR; ${slopeNote}`,
    });
  }

  // ---------------------------------------------------------------------
  // 2. Momentum (20) — RSI must confirm, and must not be exhausted.
  // ---------------------------------------------------------------------
  {
    let earned = 0;
    let note: string;
    const r = rsiValue;

    if (isBull) {
      if (r >= 75) {
        note = `RSI ${r.toFixed(1)} overbought — exhaustion risk, no credit`;
      } else if (r >= 52) {
        // Peak credit around 55-68: momentum present but not stretched.
        const distanceFromIdeal = Math.abs(r - 60) / 15;
        earned = clamp(1 - distanceFromIdeal, 0, 1) * WEIGHTS.momentum;
        note = `RSI ${r.toFixed(1)} confirms bullish momentum`;
      } else {
        note = `RSI ${r.toFixed(1)} below 52 — momentum disagrees with bull stack`;
      }
    } else {
      if (r <= 25) {
        note = `RSI ${r.toFixed(1)} oversold — exhaustion risk, no credit`;
      } else if (r <= 48) {
        const distanceFromIdeal = Math.abs(r - 40) / 15;
        earned = clamp(1 - distanceFromIdeal, 0, 1) * WEIGHTS.momentum;
        note = `RSI ${r.toFixed(1)} confirms bearish momentum`;
      } else {
        note = `RSI ${r.toFixed(1)} above 48 — momentum disagrees with bear stack`;
      }
    }

    components.push({
      name: 'momentum',
      earned: Number(earned.toFixed(2)),
      max: WEIGHTS.momentum,
      note,
    });
  }

  // ---------------------------------------------------------------------
  // 3. Entry location (20) — reward pullbacks toward the fast EMA, penalise
  //    chasing price that has already run far from it.
  // ---------------------------------------------------------------------
  {
    const distance = Math.abs(price - fast) / atrValue;
    // Ideal entry sits within ~0.5 ATR of the fast EMA; credit decays to zero
    // by 2 ATR of extension.
    const earned = clamp(1 - clamp((distance - 0.5) / 1.5, 0, 1), 0, 1) * WEIGHTS.location;
    components.push({
      name: 'location',
      earned: Number(earned.toFixed(2)),
      max: WEIGHTS.location,
      note: `price ${distance.toFixed(2)} ATR from fast EMA${distance > 2 ? ' (overextended)' : ''}`,
    });
  }

  // ---------------------------------------------------------------------
  // 4. Candle structure (20) — engulfing gets full credit, a strong directional
  //    body gets partial, a contrary or indecisive candle gets nothing.
  // ---------------------------------------------------------------------
  {
    const a = anatomy(last);
    const wantShape = isBull ? 'bullish' : 'bearish';
    let earned = 0;
    let note: string;

    if (isEngulfing(prev, last, isBull ? 'up' : 'down')) {
      earned = WEIGHTS.structure;
      note = `${wantShape} engulfing candle`;
    } else if (a.shape === wantShape) {
      // Credit proportional to body dominance, and penalise a big rejection
      // wick pointing against the trade.
      const againstWick = isBull ? a.upperWickRatio : a.lowerWickRatio;
      const bodyCredit = clamp(a.bodyRatio / 0.6, 0, 1);
      const wickPenalty = clamp(againstWick / 0.5, 0, 1);
      earned = clamp(bodyCredit - wickPenalty, 0, 1) * (WEIGHTS.structure * 0.7);
      note = `${wantShape} candle, body ${(a.bodyRatio * 100).toFixed(0)}% of range, opposing wick ${(againstWick * 100).toFixed(0)}%`;
    } else {
      note = `last candle is ${a.shape} — does not confirm ${direction}`;
    }

    components.push({
      name: 'structure',
      earned: Number(earned.toFixed(2)),
      max: WEIGHTS.structure,
      note,
    });
  }

  // ---------------------------------------------------------------------
  // 5. Volatility regime (10) — we want movement, but not a volatility spike
  //    that makes fixed-duration contracts a coin flip.
  // ---------------------------------------------------------------------
  {
    const recentAtrPct: number[] = [];
    for (let i = closed.length - 20; i < closed.length; i += 1) {
      if (i > 0) {
        const c = closed[i];
        recentAtrPct.push(((c.high - c.low) / c.close) * 100);
      }
    }
    const sd = stddev(recentAtrPct, Math.min(20, recentAtrPct.length)) ?? 0;
    const meanRange =
      recentAtrPct.reduce((a, b) => a + b, 0) / Math.max(1, recentAtrPct.length);

    let earned = 0;
    let note: string;

    if (atrPercent < 0.01) {
      note = `ATR ${atrPercent.toFixed(3)}% — market is effectively flat`;
    } else if (meanRange > 0 && sd / meanRange > 1.5) {
      note = `range volatility unstable (sd/mean ${(sd / meanRange).toFixed(2)}) — erratic`;
    } else {
      // Favour a healthy mid band; both dead and wild markets lose credit.
      const ideal = 0.15;
      const ratio = atrPercent / ideal;
      const credit = ratio <= 1 ? ratio : clamp(1 - (ratio - 1) / 3, 0, 1);
      earned = clamp(credit, 0, 1) * WEIGHTS.volatility;
      note = `ATR ${atrPercent.toFixed(3)}% of price — tradeable range`;
    }

    components.push({
      name: 'volatility',
      earned: Number(earned.toFixed(2)),
      max: WEIGHTS.volatility,
      note,
    });
  }

  const score = Number(
    clamp(components.reduce((a, c) => a + c.earned, 0), 0, 100).toFixed(2),
  );

  return {
    ok: true,
    signal: {
      symbol,
      displayName,
      direction,
      score,
      components,
      price,
      atr: Number(atrValue.toFixed(6)),
      atrPercent: Number(atrPercent.toFixed(4)),
      rsi: Number(rsiValue.toFixed(2)),
      emaFast: Number(fast.toFixed(6)),
      emaSlow: Number(slow.toFixed(6)),
      emaTrend: Number(trend.toFixed(6)),
      candleEpoch: last.epoch,
      evaluatedAt: new Date().toISOString(),
    },
  };
}

import fs from 'fs';
import path from 'path';
import type { Config } from '../config';
import { log } from '../logger';

export type HaltReason =
  | 'daily_loss_limit'
  | 'max_drawdown'
  | 'consecutive_losses'
  | 'manual'
  | null;

export interface RiskState {
  /** UTC date (YYYY-MM-DD) the daily counters belong to. */
  day: string;
  /** Balance at the start of the current UTC day. */
  dayStartBalance: number;
  /** Highest balance ever observed — the drawdown reference. */
  peakBalance: number;
  tradesToday: number;
  consecutiveLosses: number;
  realisedPnlToday: number;
  halted: boolean;
  haltReason: HaltReason;
  haltedAt: string | null;
}

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
}

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), '.bot-state.json');

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Enforces the account-level guardrails.
 *
 * Every limit here is a hard stop: when one trips the bot halts and will not
 * resume on its own. Resuming is a deliberate act (control endpoint or
 * restart with the breaker cleared), because an automated system that
 * un-halts itself after a loss streak is how accounts get emptied.
 */
export class RiskManager {
  private readonly cfg: Config;
  private state: RiskState;
  private openTrades = 0;
  private seeded = false;

  constructor(cfg: Config, startingBalance = 0) {
    this.cfg = cfg;
    this.state = this.loadState(startingBalance);
  }

  /**
   * Called once the real account balance is known.
   *
   * The manager is constructed before the Deriv handshake (so the HTTP server
   * can come up first), which means its day-start and peak references are
   * placeholders until this runs. Seeding only fills in references that were
   * never established — it never overwrites figures restored from disk, or a
   * tripped breaker would be silently cleared by a restart.
   */
  seed(startingBalance: number): void {
    if (this.seeded) return;
    this.seeded = true;
    if (this.state.dayStartBalance <= 0) this.state.dayStartBalance = startingBalance;
    if (this.state.peakBalance <= 0) this.state.peakBalance = startingBalance;
    this.persist();
    log.info('risk: seeded with account balance', {
      startingBalance,
      dayStartBalance: this.state.dayStartBalance,
      peakBalance: this.state.peakBalance,
      halted: this.state.halted,
      haltReason: this.state.haltReason,
    });
  }

  // -------------------------------------------------------------------------
  // Persistence — survives a restart so a tripped breaker is not forgotten.
  // -------------------------------------------------------------------------

  private loadState(startingBalance: number): RiskState {
    const fresh: RiskState = {
      day: today(),
      dayStartBalance: startingBalance,
      peakBalance: startingBalance,
      tradesToday: 0,
      consecutiveLosses: 0,
      realisedPnlToday: 0,
      halted: false,
      haltReason: null,
      haltedAt: null,
    };

    try {
      if (!fs.existsSync(STATE_FILE)) return fresh;
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<RiskState>;
      if (raw.day !== today()) {
        // New UTC day: reset daily counters but carry the peak balance and any
        // drawdown halt, which are not daily concepts.
        log.info('risk: new trading day, resetting daily counters', { previousDay: raw.day });
        return {
          ...fresh,
          peakBalance: Math.max(raw.peakBalance ?? startingBalance, startingBalance),
          halted: raw.haltReason === 'max_drawdown' ? Boolean(raw.halted) : false,
          haltReason: raw.haltReason === 'max_drawdown' ? 'max_drawdown' : null,
          haltedAt: raw.haltReason === 'max_drawdown' ? (raw.haltedAt ?? null) : null,
        };
      }
      log.info('risk: restored state from disk', {
        tradesToday: raw.tradesToday,
        halted: raw.halted,
        haltReason: raw.haltReason,
      });
      return { ...fresh, ...raw, day: today() } as RiskState;
    } catch (err) {
      log.warn('risk: could not read state file, starting fresh', {
        error: (err as Error).message,
      });
      return fresh;
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (err) {
      log.warn('risk: could not persist state', { error: (err as Error).message });
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  snapshot(): RiskState & { openTrades: number } {
    return { ...this.state, openTrades: this.openTrades };
  }

  get isHalted(): boolean {
    return this.state.halted;
  }

  /** Rolls daily counters when the UTC date changes mid-run. */
  private rollDayIfNeeded(currentBalance: number): void {
    const t = today();
    if (this.state.day === t) return;
    log.info('risk: rolling into new UTC day');
    this.state.day = t;
    this.state.dayStartBalance = currentBalance;
    this.state.tradesToday = 0;
    this.state.realisedPnlToday = 0;
    this.state.consecutiveLosses = 0;
    // A drawdown halt is account-level and deliberately survives the rollover.
    if (this.state.haltReason !== 'max_drawdown') {
      this.state.halted = false;
      this.state.haltReason = null;
      this.state.haltedAt = null;
    }
    this.persist();
  }

  // -------------------------------------------------------------------------
  // Breakers
  // -------------------------------------------------------------------------

  halt(reason: HaltReason, detail: string): void {
    if (this.state.halted && this.state.haltReason === reason) return;
    this.state.halted = true;
    this.state.haltReason = reason;
    this.state.haltedAt = new Date().toISOString();
    this.persist();
    log.banner([
      'TRADING HALTED',
      `Reason: ${reason}`,
      detail,
      'The bot will not place further trades until it is manually resumed.',
    ]);
  }

  resume(): void {
    this.state.halted = false;
    this.state.haltReason = null;
    this.state.haltedAt = null;
    this.state.consecutiveLosses = 0;
    this.persist();
    log.warn('risk: trading manually resumed');
  }

  /** Recomputes balance-derived breakers. Call whenever balance changes. */
  updateBalance(balance: number): void {
    this.rollDayIfNeeded(balance);

    if (balance > this.state.peakBalance) {
      this.state.peakBalance = balance;
    }

    const drawdownPct =
      this.state.peakBalance > 0
        ? ((this.state.peakBalance - balance) / this.state.peakBalance) * 100
        : 0;

    if (drawdownPct >= this.cfg.maxDrawdownPercent) {
      this.halt(
        'max_drawdown',
        `Drawdown ${drawdownPct.toFixed(2)}% from peak ${this.state.peakBalance.toFixed(2)} ` +
          `exceeds MAX_DRAWDOWN_PERCENT of ${this.cfg.maxDrawdownPercent}%.`,
      );
    }

    const dayLossPct =
      this.state.dayStartBalance > 0
        ? ((this.state.dayStartBalance - balance) / this.state.dayStartBalance) * 100
        : 0;

    if (dayLossPct >= this.cfg.dailyLossLimitPercent) {
      this.halt(
        'daily_loss_limit',
        `Down ${dayLossPct.toFixed(2)}% today (from ${this.state.dayStartBalance.toFixed(2)}), ` +
          `at or beyond DAILY_LOSS_LIMIT_PERCENT of ${this.cfg.dailyLossLimitPercent}%.`,
      );
    }

    this.persist();
  }

  /** Gate checked immediately before every order. */
  canTrade(): RiskDecision {
    if (this.state.halted) {
      return { allowed: false, reason: `halted (${this.state.haltReason})` };
    }
    if (this.openTrades >= this.cfg.maxOpenTrades) {
      return {
        allowed: false,
        reason: `max open trades reached (${this.openTrades}/${this.cfg.maxOpenTrades})`,
      };
    }
    if (this.state.tradesToday >= this.cfg.maxTradesPerDay) {
      return {
        allowed: false,
        reason: `daily trade cap reached (${this.state.tradesToday}/${this.cfg.maxTradesPerDay})`,
      };
    }
    if (this.state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
      return {
        allowed: false,
        reason: `consecutive loss limit reached (${this.state.consecutiveLosses}/${this.cfg.maxConsecutiveLosses})`,
      };
    }
    return { allowed: true };
  }

  /**
   * Position size for a binary contract. The stake *is* the maximum loss on a
   * CALL/PUT contract, so risking N% of balance means staking exactly N%.
   */
  stakeFor(balance: number): number {
    const raw = (balance * this.cfg.riskPerTradePercent) / 100;
    // Deriv's minimum stake is 0.35 USD on most contracts; round to cents.
    return Math.max(0.35, Number(raw.toFixed(2)));
  }

  // -------------------------------------------------------------------------
  // Trade lifecycle hooks
  // -------------------------------------------------------------------------

  recordTradeOpened(): void {
    this.openTrades += 1;
    this.state.tradesToday += 1;
    this.persist();
  }

  /** Called when a contract settles. `profit` is negative on a loss. */
  recordTradeClosed(profit: number): void {
    this.openTrades = Math.max(0, this.openTrades - 1);
    this.state.realisedPnlToday += profit;

    if (profit < 0) {
      this.state.consecutiveLosses += 1;
      if (this.state.consecutiveLosses >= this.cfg.maxConsecutiveLosses) {
        this.halt(
          'consecutive_losses',
          `${this.state.consecutiveLosses} losses in a row, at MAX_CONSECUTIVE_LOSSES of ${this.cfg.maxConsecutiveLosses}.`,
        );
      }
    } else {
      this.state.consecutiveLosses = 0;
    }
    this.persist();
  }

  /** Used when an order is attempted but never actually opened. */
  releaseSlot(): void {
    this.openTrades = Math.max(0, this.openTrades - 1);
  }

  syncOpenTrades(count: number): void {
    this.openTrades = count;
  }
}

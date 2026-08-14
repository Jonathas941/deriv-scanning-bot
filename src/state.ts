import type { Signal } from './strategy/scorer';

export interface TradeRecord {
  contractId: number;
  symbol: string;
  displayName: string;
  direction: string;
  stake: number;
  payout: number;
  score: number;
  openedAt: string;
  closedAt: string | null;
  profit: number | null;
  status: 'open' | 'won' | 'lost' | 'cancelled';
  dryRun: boolean;
  longcode?: string;
}

export interface ScanSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  symbolsScanned: number;
  signalsFound: number;
  bestScore: number | null;
  errors: string[];
}

const MAX_SIGNALS = 200;
const MAX_TRADES = 500;
const MAX_SCANS = 50;

/**
 * In-memory ring buffers backing the API and dashboard.
 *
 * Deliberately not a database: this is observability data, and losing it on
 * restart is acceptable. Anything that must survive a restart (risk breakers)
 * lives in RiskManager's state file instead.
 */
export class Store {
  readonly startedAt = new Date().toISOString();

  private signals: Signal[] = [];
  private trades: TradeRecord[] = [];
  private scans: ScanSummary[] = [];

  account: {
    loginId: string;
    isVirtual: boolean;
    currency: string;
    balance: number;
  } | null = null;

  connected = false;
  lastError: { message: string; at: string } | null = null;
  scanning = false;

  addSignal(signal: Signal): void {
    this.signals.unshift(signal);
    if (this.signals.length > MAX_SIGNALS) this.signals.length = MAX_SIGNALS;
  }

  recentSignals(limit = 50): Signal[] {
    return this.signals.slice(0, limit);
  }

  addTrade(trade: TradeRecord): void {
    this.trades.unshift(trade);
    if (this.trades.length > MAX_TRADES) this.trades.length = MAX_TRADES;
  }

  updateTrade(contractId: number, patch: Partial<TradeRecord>): TradeRecord | null {
    const t = this.trades.find((x) => x.contractId === contractId);
    if (!t) return null;
    Object.assign(t, patch);
    return t;
  }

  findTrade(contractId: number): TradeRecord | undefined {
    return this.trades.find((x) => x.contractId === contractId);
  }

  recentTrades(limit = 50): TradeRecord[] {
    return this.trades.slice(0, limit);
  }

  addScan(summary: ScanSummary): void {
    this.scans.unshift(summary);
    if (this.scans.length > MAX_SCANS) this.scans.length = MAX_SCANS;
  }

  lastScan(): ScanSummary | null {
    return this.scans[0] ?? null;
  }

  recentScans(limit = 20): ScanSummary[] {
    return this.scans.slice(0, limit);
  }

  stats(): {
    total: number;
    won: number;
    lost: number;
    open: number;
    winRate: number | null;
    netProfit: number;
  } {
    const settled = this.trades.filter((t) => t.status === 'won' || t.status === 'lost');
    const won = settled.filter((t) => t.status === 'won').length;
    const lost = settled.filter((t) => t.status === 'lost').length;
    const open = this.trades.filter((t) => t.status === 'open').length;
    const netProfit = settled.reduce((a, t) => a + (t.profit ?? 0), 0);
    return {
      total: this.trades.length,
      won,
      lost,
      open,
      winRate: settled.length > 0 ? Number(((won / settled.length) * 100).toFixed(1)) : null,
      netProfit: Number(netProfit.toFixed(2)),
    };
  }

  noteError(message: string): void {
    this.lastError = { message, at: new Date().toISOString() };
  }
}

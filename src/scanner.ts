import type { Config } from './config';
import type { DerivClient } from './deriv/client';
import type { ActiveSymbol } from './deriv/types';
import { log } from './logger';
import type { RiskManager } from './risk/manager';
import type { Store } from './state';
import { evaluate, type Signal } from './strategy/scorer';
import type { Executor } from './trading/executor';
import type { Webhook } from './webhook';

/** Deriv market keys we understand, mapped from the SCAN_MARKETS config. */
const MARKET_ALIASES: Record<string, string[]> = {
  synthetic_index: ['synthetic_index'],
  synthetics: ['synthetic_index'],
  forex: ['forex'],
  fx: ['forex'],
};

export class Scanner {
  private readonly cfg: Config;
  private readonly client: DerivClient;
  private readonly risk: RiskManager;
  private readonly store: Store;
  private readonly executor: Executor;
  private readonly webhook: Webhook;

  private symbols: ActiveSymbol[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    cfg: Config,
    client: DerivClient,
    risk: RiskManager,
    store: Store,
    executor: Executor,
    webhook: Webhook,
  ) {
    this.cfg = cfg;
    this.client = client;
    this.risk = risk;
    this.store = store;
    this.executor = executor;
    this.webhook = webhook;
  }

  // -------------------------------------------------------------------------
  // Symbol discovery
  // -------------------------------------------------------------------------

  async resolveSymbols(): Promise<ActiveSymbol[]> {
    const all = await this.client.activeSymbols();

    // Explicit list wins — the operator asked for these exact symbols.
    if (this.cfg.scanSymbols.length > 0) {
      const wanted = new Set(this.cfg.scanSymbols);
      const matched = all.filter((s) => wanted.has(s.symbol));
      const missing = [...wanted].filter((w) => !matched.some((m) => m.symbol === w));
      if (missing.length > 0) {
        log.warn('scanner: some SCAN_SYMBOLS are not available on this account', { missing });
      }
      if (matched.length === 0) {
        throw new Error(
          `None of the configured SCAN_SYMBOLS exist for this account: ${this.cfg.scanSymbols.join(', ')}`,
        );
      }
      this.symbols = matched;
      return matched;
    }

    const markets = new Set<string>();
    for (const m of this.cfg.scanMarkets) {
      for (const key of MARKET_ALIASES[m.toLowerCase()] ?? [m.toLowerCase()]) {
        markets.add(key);
      }
    }

    const candidates = all.filter(
      (s) => markets.has(s.market) && s.is_trading_suspended === 0,
    );

    if (candidates.length === 0) {
      throw new Error(
        `No tradeable symbols found for markets: ${[...markets].join(', ')}. ` +
          `Available markets on this account: ${[...new Set(all.map((s) => s.market))].join(', ')}`,
      );
    }

    // Spread the budget across markets rather than letting one market (there
    // are far more synthetics than majors) crowd the other out entirely.
    const byMarket = new Map<string, ActiveSymbol[]>();
    for (const s of candidates) {
      const list = byMarket.get(s.market) ?? [];
      list.push(s);
      byMarket.set(s.market, list);
    }

    const perMarket = Math.max(1, Math.floor(this.cfg.maxScanSymbols / byMarket.size));
    const chosen: ActiveSymbol[] = [];
    for (const list of byMarket.values()) {
      chosen.push(...list.slice(0, perMarket));
    }
    // Fill any remaining budget from whatever is left.
    if (chosen.length < this.cfg.maxScanSymbols) {
      const chosenSet = new Set(chosen.map((c) => c.symbol));
      for (const c of candidates) {
        if (chosen.length >= this.cfg.maxScanSymbols) break;
        if (!chosenSet.has(c.symbol)) chosen.push(c);
      }
    }

    this.symbols = chosen.slice(0, this.cfg.maxScanSymbols);
    log.info('scanner: symbols resolved', {
      count: this.symbols.length,
      symbols: this.symbols.map((s) => s.symbol),
    });
    return this.symbols;
  }

  get activeSymbols(): ActiveSymbol[] {
    return this.symbols;
  }

  // -------------------------------------------------------------------------
  // Scan loop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const intervalMs = this.cfg.scanIntervalSeconds * 1000;
    log.info('scanner: starting', { intervalSeconds: this.cfg.scanIntervalSeconds });

    // Kick off immediately, then on a fixed cadence.
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One full pass over every configured symbol. */
  async runOnce(): Promise<void> {
    if (this.running) {
      log.debug('scanner: previous scan still running, skipping this tick');
      return;
    }
    if (this.stopped) return;
    if (!this.client.isConnected) {
      log.debug('scanner: socket not connected, skipping tick');
      return;
    }

    this.running = true;
    this.store.scanning = true;
    const startedAt = new Date();
    const errors: string[] = [];
    const found: Signal[] = [];

    try {
      // Refresh balance so the risk breakers act on current numbers.
      try {
        const bal = await this.client.balance();
        if (this.store.account) {
          this.store.account.balance = bal.balance;
        }
        this.risk.updateBalance(bal.balance);
      } catch (err) {
        errors.push(`balance: ${(err as Error).message}`);
      }

      for (const sym of this.symbols) {
        if (this.stopped) break;

        // Skip closed markets rather than burning quota on them.
        if (sym.exchange_is_open === 0) {
          log.debug('scanner: market closed', { symbol: sym.symbol });
          continue;
        }

        try {
          const candles = await this.client.candles(
            sym.symbol,
            this.cfg.candleGranularity,
            this.cfg.candleCount,
          );
          const result = evaluate(sym.symbol, sym.display_name, candles, this.cfg);

          if (!result.ok) {
            log.debug('scanner: no signal', {
              symbol: sym.symbol,
              reason: result.rejection.reason,
            });
            continue;
          }

          const signal = result.signal;
          this.store.addSignal(signal);

          if (signal.score >= this.cfg.minSignalScore) {
            found.push(signal);
            log.info('scanner: SIGNAL', {
              symbol: signal.symbol,
              direction: signal.direction,
              score: signal.score,
            });
            this.webhook.send('signal', {
              symbol: signal.symbol,
              displayName: signal.displayName,
              direction: signal.direction,
              score: signal.score,
              price: signal.price,
              rsi: signal.rsi,
              components: signal.components,
            });
          } else {
            log.debug('scanner: below threshold', {
              symbol: signal.symbol,
              score: signal.score,
              threshold: this.cfg.minSignalScore,
            });
          }
        } catch (err) {
          const msg = `${sym.symbol}: ${(err as Error).message}`;
          errors.push(msg);
          log.warn('scanner: symbol scan failed', { symbol: sym.symbol, error: (err as Error).message });
        }
      }

      // Act on the strongest signal only. Firing every qualifying signal in one
      // tick is how a bot ends up with a dozen correlated positions at once.
      if (found.length > 0) {
        found.sort((a, b) => b.score - a.score);
        const best = found[0];
        const result = await this.executor.execute(best);
        if (!result.executed && result.reason) {
          log.info('scanner: best signal not executed', {
            symbol: best.symbol,
            reason: result.reason,
          });
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(msg);
      this.store.noteError(msg);
      log.error('scanner: scan failed', { error: msg });
    } finally {
      const finishedAt = new Date();
      this.store.addScan({
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        symbolsScanned: this.symbols.length,
        signalsFound: found.length,
        bestScore: found.length > 0 ? found[0].score : null,
        errors,
      });
      this.running = false;
      this.store.scanning = false;
    }
  }
}

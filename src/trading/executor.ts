import type { Config } from '../config';
import type { DerivClient } from '../deriv/client';
import { DerivApiError } from '../deriv/client';
import type { OpenContract } from '../deriv/types';
import { log } from '../logger';
import type { RiskManager } from '../risk/manager';
import type { Store, TradeRecord } from '../state';
import type { Signal } from '../strategy/scorer';
import type { Webhook } from '../webhook';

export interface ExecutionResult {
  executed: boolean;
  dryRun: boolean;
  reason?: string;
  trade?: TradeRecord;
}

/**
 * Turns an accepted signal into a Deriv contract.
 *
 * The real-money gate is checked here, at the last possible moment before the
 * order leaves the process, rather than earlier in the pipeline. That way no
 * refactor upstream can accidentally route around it.
 */
export class Executor {
  private readonly cfg: Config;
  private readonly client: DerivClient;
  private readonly risk: RiskManager;
  private readonly store: Store;
  private readonly webhook: Webhook;
  private readonly tracked = new Set<number>();

  constructor(
    cfg: Config,
    client: DerivClient,
    risk: RiskManager,
    store: Store,
    webhook: Webhook,
  ) {
    this.cfg = cfg;
    this.client = client;
    this.risk = risk;
    this.store = store;
    this.webhook = webhook;

    this.client.on('contract', (c: OpenContract) => this.onContractUpdate(c));
  }

  async execute(signal: Signal): Promise<ExecutionResult> {
    const gate = this.risk.canTrade();
    if (!gate.allowed) {
      log.info('executor: blocked by risk manager', {
        symbol: signal.symbol,
        reason: gate.reason,
      });
      return { executed: false, dryRun: !this.cfg.enableRealTrading, reason: gate.reason };
    }

    const account = this.client.account;
    if (!account) {
      return { executed: false, dryRun: true, reason: 'not authorized' };
    }

    const balance = this.store.account?.balance ?? account.balance;
    const stake = this.risk.stakeFor(balance);

    if (stake > balance) {
      return { executed: false, dryRun: true, reason: 'stake exceeds available balance' };
    }

    // Always price the contract, even in dry run — a quote that Deriv rejects
    // tells us the signal was untradeable, which is worth knowing before we arm.
    let proposal;
    try {
      proposal = await this.client.proposal({
        symbol: signal.symbol,
        contractType: signal.direction,
        amount: stake,
        currency: account.currency,
        duration: this.cfg.contractDuration,
        durationUnit: this.cfg.contractDurationUnit,
      });
    } catch (err) {
      const e = err as DerivApiError;
      log.warn('executor: proposal rejected', {
        symbol: signal.symbol,
        code: e.code,
        error: e.message,
      });
      return { executed: false, dryRun: !this.cfg.enableRealTrading, reason: `proposal: ${e.message}` };
    }

    // ---------------------------------------------------------------------
    // THE GATE. Nothing below this line runs unless real trading is armed.
    // ---------------------------------------------------------------------
    if (!this.cfg.enableRealTrading) {
      const record: TradeRecord = {
        contractId: -Date.now(), // synthetic id; negative marks it as simulated
        symbol: signal.symbol,
        displayName: signal.displayName,
        direction: signal.direction,
        stake,
        payout: proposal.payout,
        score: signal.score,
        openedAt: new Date().toISOString(),
        closedAt: null,
        profit: null,
        status: 'cancelled',
        dryRun: true,
        longcode: proposal.longcode,
      };
      this.store.addTrade(record);
      log.info('executor: DRY RUN — order not sent', {
        symbol: signal.symbol,
        direction: signal.direction,
        score: signal.score,
        stake,
        wouldPayout: proposal.payout,
      });
      return { executed: false, dryRun: true, reason: 'ENABLE_REAL_TRADING is false', trade: record };
    }

    // Reserve the slot before the network call so two concurrent scans cannot
    // both slip past maxOpenTrades.
    this.risk.recordTradeOpened();

    try {
      // Cap what we will pay at the quoted ask price: if the market moved,
      // Deriv rejects rather than filling us at a worse number.
      const bought = await this.client.buy(proposal.id, proposal.ask_price);

      const record: TradeRecord = {
        contractId: bought.contract_id,
        symbol: signal.symbol,
        displayName: signal.displayName,
        direction: signal.direction,
        stake: bought.buy_price,
        payout: bought.payout,
        score: signal.score,
        openedAt: new Date().toISOString(),
        closedAt: null,
        profit: null,
        status: 'open',
        dryRun: false,
        longcode: bought.longcode,
      };
      this.store.addTrade(record);

      log.info('executor: TRADE PLACED', {
        contractId: bought.contract_id,
        symbol: signal.symbol,
        direction: signal.direction,
        stake: bought.buy_price,
        payout: bought.payout,
        score: signal.score,
      });

      this.webhook.send('trade', {
        action: 'opened',
        contractId: bought.contract_id,
        symbol: signal.symbol,
        displayName: signal.displayName,
        direction: signal.direction,
        stake: bought.buy_price,
        payout: bought.payout,
        score: signal.score,
      });

      // Subscribe for settlement updates.
      this.tracked.add(bought.contract_id);
      this.client.subscribeOpenContract(bought.contract_id).catch((err: Error) => {
        log.warn('executor: could not subscribe to contract updates', {
          contractId: bought.contract_id,
          error: err.message,
        });
      });

      return { executed: true, dryRun: false, trade: record };
    } catch (err) {
      // The order never opened, so give the slot back.
      this.risk.releaseSlot();
      const e = err as DerivApiError;
      log.error('executor: buy failed', {
        symbol: signal.symbol,
        code: e.code,
        error: e.message,
      });
      this.store.noteError(`buy failed on ${signal.symbol}: ${e.message}`);
      return { executed: false, dryRun: false, reason: `buy: ${e.message}` };
    }
  }

  /** Handles settlement pushed over the proposal_open_contract subscription. */
  private onContractUpdate(contract: OpenContract): void {
    if (!contract?.contract_id) return;
    if (contract.is_sold !== 1) return;
    if (!this.tracked.has(contract.contract_id)) return;

    this.tracked.delete(contract.contract_id);

    const profit = Number(contract.profit ?? 0);
    const status = profit >= 0 ? 'won' : 'lost';

    this.store.updateTrade(contract.contract_id, {
      status,
      profit: Number(profit.toFixed(2)),
      closedAt: new Date().toISOString(),
    });

    this.risk.recordTradeClosed(profit);

    log.info('executor: contract settled', {
      contractId: contract.contract_id,
      status,
      profit: Number(profit.toFixed(2)),
    });

    this.webhook.send('trade', {
      action: 'settled',
      contractId: contract.contract_id,
      symbol: contract.underlying,
      status,
      profit: Number(profit.toFixed(2)),
    });
  }

  get trackedCount(): number {
    return this.tracked.size;
  }
}

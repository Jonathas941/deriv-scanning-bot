import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Each test gets its own state file so persistence never leaks between cases.
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-test-'));
  process.env.STATE_FILE = path.join(tmpDir, 'state.json');
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.STATE_FILE;
});

/** Fresh module instance per test, so STATE_FILE is re-read. */
async function freshRiskManager() {
  const modPath = require.resolve('../src/risk/manager');
  delete require.cache[modPath];
  return (await import(`../src/risk/manager?${Date.now()}${Math.random()}`)) as typeof import('../src/risk/manager');
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    riskPerTradePercent: 1,
    maxTradesPerDay: 5,
    maxOpenTrades: 2,
    maxConsecutiveLosses: 3,
    dailyLossLimitPercent: 5,
    maxDrawdownPercent: 10,
    ...overrides,
  } as never;
}

describe('RiskManager position sizing', () => {
  it('stakes the configured percentage of balance', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ riskPerTradePercent: 2 }), 1000);
    assert.equal(rm.stakeFor(1000), 20);
  });

  it('never returns below the Deriv minimum stake', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ riskPerTradePercent: 1 }), 5);
    assert.equal(rm.stakeFor(5), 0.35);
  });

  it('rounds to two decimal places', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ riskPerTradePercent: 1 }), 333.333);
    assert.equal(rm.stakeFor(333.333), 3.33);
  });
});

describe('RiskManager trade gating', () => {
  it('allows trading from a clean state', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig(), 1000);
    assert.equal(rm.canTrade().allowed, true);
  });

  it('blocks once max open trades is reached', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ maxOpenTrades: 2 }), 1000);
    rm.recordTradeOpened();
    rm.recordTradeOpened();
    const d = rm.canTrade();
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /max open trades/);
  });

  it('blocks once the daily trade cap is reached', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ maxTradesPerDay: 2, maxOpenTrades: 99 }), 1000);
    rm.recordTradeOpened();
    rm.recordTradeClosed(1);
    rm.recordTradeOpened();
    rm.recordTradeClosed(1);
    const d = rm.canTrade();
    assert.equal(d.allowed, false);
    assert.match(d.reason!, /daily trade cap/);
  });

  it('releases the slot when an order fails to open', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ maxOpenTrades: 1 }), 1000);
    rm.recordTradeOpened();
    assert.equal(rm.canTrade().allowed, false);
    rm.releaseSlot();
    assert.equal(rm.canTrade().allowed, true);
  });
});

describe('RiskManager circuit breakers', () => {
  it('halts after the configured consecutive losses', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ maxConsecutiveLosses: 3 }), 1000);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-10);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-10);
    assert.equal(rm.isHalted, false, 'should not halt before the limit');
    rm.recordTradeOpened();
    rm.recordTradeClosed(-10);
    assert.equal(rm.isHalted, true);
    assert.equal(rm.snapshot().haltReason, 'consecutive_losses');
  });

  it('resets the loss streak after a win', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ maxConsecutiveLosses: 3 }), 1000);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-10);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-10);
    rm.recordTradeOpened();
    rm.recordTradeClosed(+20);
    assert.equal(rm.snapshot().consecutiveLosses, 0);
    rm.recordTradeOpened();
    rm.recordTradeClosed(-10);
    assert.equal(rm.isHalted, false);
  });

  it('halts on the daily loss limit', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ dailyLossLimitPercent: 5 }), 1000);
    rm.seed(1000);
    rm.updateBalance(960); // -4%, still inside the limit
    assert.equal(rm.isHalted, false);
    rm.updateBalance(949); // -5.1%
    assert.equal(rm.isHalted, true);
    assert.equal(rm.snapshot().haltReason, 'daily_loss_limit');
  });

  it('halts on max drawdown measured from the peak, not the start', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(
      makeConfig({ maxDrawdownPercent: 10, dailyLossLimitPercent: 99 }),
      1000,
    );
    rm.seed(1000);
    rm.updateBalance(2000); // new peak
    assert.equal(rm.isHalted, false);
    rm.updateBalance(1850); // -7.5% from peak
    assert.equal(rm.isHalted, false);
    rm.updateBalance(1790); // -10.5% from peak
    assert.equal(rm.isHalted, true);
    assert.equal(rm.snapshot().haltReason, 'max_drawdown');
  });

  it('blocks trading while halted and allows it again after resume', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig(), 1000);
    rm.halt('manual', 'test');
    assert.equal(rm.canTrade().allowed, false);
    rm.resume();
    assert.equal(rm.canTrade().allowed, true);
    assert.equal(rm.isHalted, false);
  });

  it('does not clear a tripped breaker just because balance recovers', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig({ dailyLossLimitPercent: 5 }), 1000);
    rm.seed(1000);
    rm.updateBalance(900);
    assert.equal(rm.isHalted, true);
    rm.updateBalance(1000);
    assert.equal(rm.isHalted, true, 'a breaker must require a deliberate resume');
  });
});

describe('RiskManager persistence', () => {
  it('restores a halted state across a restart', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig(), 1000);
    rm.seed(1000);
    rm.halt('manual', 'operator stopped it');

    const { RiskManager: Reloaded } = await freshRiskManager();
    const rm2 = new Reloaded(makeConfig(), 1000);
    assert.equal(rm2.isHalted, true, 'a restart must not clear a halt');
    assert.equal(rm2.snapshot().haltReason, 'manual');
  });

  it('restores the daily trade count across a restart', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig(), 1000);
    rm.recordTradeOpened();
    rm.recordTradeOpened();

    const { RiskManager: Reloaded } = await freshRiskManager();
    const rm2 = new Reloaded(makeConfig(), 1000);
    assert.equal(rm2.snapshot().tradesToday, 2);
  });

  it('seed does not overwrite restored balances', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig(), 1000);
    rm.seed(1000);
    rm.updateBalance(1500); // peak becomes 1500

    const { RiskManager: Reloaded } = await freshRiskManager();
    const rm2 = new Reloaded(makeConfig(), 800);
    rm2.seed(800);
    assert.equal(rm2.snapshot().peakBalance, 1500, 'peak must survive a restart');
  });

  it('starts clean when no state file exists', async () => {
    const { RiskManager } = await freshRiskManager();
    const rm = new RiskManager(makeConfig(), 500);
    const s = rm.snapshot();
    assert.equal(s.halted, false);
    assert.equal(s.tradesToday, 0);
    assert.equal(s.consecutiveLosses, 0);
  });
});

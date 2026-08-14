import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from '../config';
import type { DerivClient } from '../deriv/client';
import { log } from '../logger';
import type { RiskManager } from '../risk/manager';
import type { Scanner } from '../scanner';
import type { Store } from '../state';
import { renderDashboard } from './dashboard';

export interface ApiDeps {
  cfg: Config;
  store: Store;
  risk: RiskManager;
  client: DerivClient;
  scanner: Scanner;
}

export function buildApp(deps: ApiDeps): express.Express {
  const { cfg, store, risk, client, scanner } = deps;
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // ---------------------------------------------------------------------
  // Health — deliberately shallow.
  //
  // Railway restarts the container when this fails. A brief Deriv outage
  // should NOT kill a healthy process that is already reconnecting, so this
  // reports 200 whenever the process is serving, and puts the upstream
  // connection state in the body for humans and monitors to read.
  // ---------------------------------------------------------------------
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      derivConnected: client.isConnected,
      tradingArmed: cfg.enableRealTrading,
      halted: risk.isHalted,
      startedAt: store.startedAt,
    });
  });

  // ---------------------------------------------------------------------
  // Read-only API
  // ---------------------------------------------------------------------

  app.get('/api/status', (_req: Request, res: Response) => {
    const riskState = risk.snapshot();
    res.json({
      startedAt: store.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
      deriv: {
        connected: client.isConnected,
        account: store.account
          ? {
              loginId: store.account.loginId,
              type: store.account.isVirtual ? 'demo' : 'real',
              currency: store.account.currency,
              balance: store.account.balance,
            }
          : null,
      },
      trading: {
        armed: cfg.enableRealTrading,
        mode: cfg.enableRealTrading
          ? store.account?.isVirtual
            ? 'live-demo'
            : 'live-real'
          : 'dry-run',
        halted: riskState.halted,
        haltReason: riskState.haltReason,
        haltedAt: riskState.haltedAt,
      },
      risk: {
        ...riskState,
        limits: {
          riskPerTradePercent: cfg.riskPerTradePercent,
          maxTradesPerDay: cfg.maxTradesPerDay,
          maxOpenTrades: cfg.maxOpenTrades,
          maxConsecutiveLosses: cfg.maxConsecutiveLosses,
          dailyLossLimitPercent: cfg.dailyLossLimitPercent,
          maxDrawdownPercent: cfg.maxDrawdownPercent,
        },
      },
      scanner: {
        scanning: store.scanning,
        intervalSeconds: cfg.scanIntervalSeconds,
        minSignalScore: cfg.minSignalScore,
        symbolCount: scanner.activeSymbols.length,
        lastScan: store.lastScan(),
      },
      stats: store.stats(),
      lastError: store.lastError,
    });
  });

  app.get('/api/signals', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const minScore = Number(req.query.minScore);
    let signals = store.recentSignals(limit);
    if (Number.isFinite(minScore)) {
      signals = signals.filter((s) => s.score >= minScore);
    }
    res.json({ count: signals.length, signals });
  });

  app.get('/api/trades', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    res.json({ stats: store.stats(), trades: store.recentTrades(limit) });
  });

  app.get('/api/scans', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    res.json({ scans: store.recentScans(limit) });
  });

  app.get('/api/symbols', (_req: Request, res: Response) => {
    res.json({
      count: scanner.activeSymbols.length,
      symbols: scanner.activeSymbols.map((s) => ({
        symbol: s.symbol,
        displayName: s.display_name,
        market: s.market,
        submarket: s.submarket,
        open: s.exchange_is_open === 1,
      })),
    });
  });

  // ---------------------------------------------------------------------
  // Control endpoints — mutating, therefore gated.
  //
  // With no ADMIN_API_KEY set these return 404 rather than running unguarded.
  // An unauthenticated "resume trading" button on a public URL would be an
  // obvious way to lose money.
  // ---------------------------------------------------------------------
  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!cfg.adminApiKey) {
      res.status(404).json({
        error: 'Control endpoints are disabled. Set ADMIN_API_KEY to enable them.',
      });
      return;
    }
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Length-independent compare is overkill here, but constant-ish is cheap.
    if (token.length !== cfg.adminApiKey.length || token !== cfg.adminApiKey) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  app.post('/control/halt', requireAdmin, (req: Request, res: Response) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'operator request';
    risk.halt('manual', reason);
    log.warn('api: manual halt requested', { reason });
    res.json({ ok: true, halted: true, reason });
  });

  app.post('/control/resume', requireAdmin, (_req: Request, res: Response) => {
    risk.resume();
    res.json({ ok: true, halted: false });
  });

  app.post('/control/scan', requireAdmin, (_req: Request, res: Response) => {
    void scanner.runOnce();
    res.json({ ok: true, triggered: true });
  });

  // ---------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(renderDashboard());
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express error handler must keep all four parameters to be recognised.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('api: unhandled error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

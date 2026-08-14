import http from 'http';
import { announceTradingMode, ConfigError, loadConfig, type Config } from './config';
import { DerivClient } from './deriv/client';
import { log } from './logger';
import { RiskManager } from './risk/manager';
import { Scanner } from './scanner';
import { buildApp } from './server/api';
import { Store } from './state';
import { Executor } from './trading/executor';
import { Webhook } from './webhook';

/**
 * Verifies the account Deriv authorised is the one the operator intended.
 *
 * A token silently pointing at a real account while the config says "demo" is
 * exactly the mistake that costs money, so this refuses to start rather than
 * warning and carrying on.
 */
function assertAccountMatchesConfig(
  cfg: Config,
  auth: { loginid: string; is_virtual: 0 | 1 },
): void {
  const isVirtual = auth.is_virtual === 1;
  const expectedVirtual = cfg.accountType === 'demo';

  if (isVirtual !== expectedVirtual) {
    throw new Error(
      `Account type mismatch. DERIV_ACCOUNT_TYPE is "${cfg.accountType}" but the token ` +
        `authorised ${auth.loginid}, which is a ${isVirtual ? 'demo' : 'REAL'} account. ` +
        `Refusing to start. Fix DERIV_ACCOUNT_TYPE or use the correct token.`,
    );
  }

  if (cfg.accountId && cfg.accountId !== auth.loginid) {
    throw new Error(
      `Account mismatch. DERIV_ACCOUNT_ID is "${cfg.accountId}" but the token authorised ` +
        `"${auth.loginid}". Refusing to start.`,
    );
  }
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('startup: invalid configuration', { error: err.message });
      process.exit(1);
    }
    throw err;
  }

  const store = new Store();
  const webhook = new Webhook(cfg);
  const client = new DerivClient(cfg.wsUrl, cfg.accessToken);

  // Constructed now so the HTTP server can expose risk state immediately;
  // its balance references are filled in by seed() after authorize.
  const risk = new RiskManager(cfg);
  const executor = new Executor(cfg, client, risk, store, webhook);
  const scanner = new Scanner(cfg, client, risk, store, executor, webhook);

  // -------------------------------------------------------------------------
  // Start the HTTP server FIRST.
  //
  // Railway's healthcheck must pass before the deploy is accepted. If we
  // waited on the Deriv handshake, a slow or failing upstream would fail the
  // healthcheck and Railway would kill an otherwise-fine container.
  // -------------------------------------------------------------------------
  const app = buildApp({ cfg, store, risk, client, scanner });
  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, '0.0.0.0', () => {
      log.info('http: listening', { port: cfg.port });
      resolve();
    });
  });

  client.on('connected', () => {
    store.connected = true;
  });
  client.on('disconnected', () => {
    store.connected = false;
  });
  client.on('balance', (b: { balance: number }) => {
    if (store.account) store.account.balance = b.balance;
    risk.updateBalance(b.balance);
  });

  // -------------------------------------------------------------------------
  // Now bring up the trading side.
  // -------------------------------------------------------------------------
  const initTradingSide = async (): Promise<void> => {
    const auth = await client.connect();
    assertAccountMatchesConfig(cfg, auth);

    store.account = {
      loginId: auth.loginid,
      isVirtual: auth.is_virtual === 1,
      currency: auth.currency,
      balance: Number(auth.balance),
    };
    store.connected = true;

    risk.seed(Number(auth.balance));

    log.info('deriv: authorized', {
      loginId: auth.loginid,
      type: auth.is_virtual === 1 ? 'demo' : 'real',
      currency: auth.currency,
      balance: auth.balance,
    });

    announceTradingMode(cfg, auth.is_virtual === 1, auth.loginid);

    // Reconcile any positions that survived a restart.
    try {
      const open = await client.portfolio();
      if (open.length > 0) {
        log.warn('startup: found existing open contracts', { count: open.length });
        risk.syncOpenTrades(open.length);
      }
    } catch (err) {
      log.warn('startup: could not read portfolio', { error: (err as Error).message });
    }

    await scanner.resolveSymbols();
    scanner.start();

    webhook.send('startup', {
      account: auth.loginid,
      type: auth.is_virtual === 1 ? 'demo' : 'real',
      tradingArmed: cfg.enableRealTrading,
      symbols: scanner.activeSymbols.length,
    });
  };

  /**
   * Retries the trading-side bring-up.
   *
   * The client only self-heals once it has been connected at least
   * successfully; a failure on the very first attempt (Deriv down, DNS, a
   * transient 5xx) would otherwise leave the process alive but permanently
   * idle. Configuration mistakes are NOT retried — a wrong account type or a
   * bad symbol list will never fix itself, and hammering the API will not help.
   */
  const startTradingSide = async (attempt = 1): Promise<void> => {
    try {
      await initTradingSide();
      log.info('startup: trading side ready');
    } catch (err) {
      const message = (err as Error).message;
      store.noteError(message);

      const isFatalConfig =
        message.includes('mismatch') ||
        message.includes('SCAN_SYMBOLS') ||
        message.includes('InvalidToken') ||
        message.includes('AuthorizationRequired');

      if (isFatalConfig) {
        log.error('startup: unrecoverable configuration problem, not retrying', {
          error: message,
        });
        return;
      }

      const delayMs = Math.min(5000 * 2 ** (attempt - 1), 120_000);
      log.error('startup: trading side failed, will retry', {
        error: message,
        attempt,
        retryInMs: delayMs,
      });
      setTimeout(() => void startTradingSide(attempt + 1), delayMs).unref();
    }
  };

  // The HTTP server stays up regardless, so /health keeps reporting and the
  // dashboard can show the failure instead of the container restart-looping.
  void startTradingSide();

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown: signal received', { signal });
    scanner.stop();
    client.close();
    server.close(() => {
      log.info('shutdown: complete');
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { error: String(reason) });
    store.noteError(`unhandled rejection: ${String(reason)}`);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: err.message, stack: err.stack });
    store.noteError(`uncaught exception: ${err.message}`);
  });
}

void main().catch((err: Error) => {
  log.error('fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});

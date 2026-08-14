import { log } from './logger';

export interface Config {
  // Deriv
  appId: string;
  accessToken: string;
  accountId: string | null;
  accountType: 'demo' | 'real';
  wsUrl: string;

  // Safety
  enableRealTrading: boolean;

  // Signal
  minSignalScore: number;

  // Risk
  riskPerTradePercent: number;
  maxTradesPerDay: number;
  maxOpenTrades: number;
  maxConsecutiveLosses: number;
  dailyLossLimitPercent: number;
  maxDrawdownPercent: number;

  // Markets
  scanSymbols: string[];
  scanMarkets: string[];
  maxScanSymbols: number;

  // Strategy
  candleGranularity: number;
  candleCount: number;
  scanIntervalSeconds: number;
  contractDuration: number;
  contractDurationUnit: string;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  rsiPeriod: number;
  atrPeriod: number;

  // Server
  port: number;
  nodeEnv: string;
  adminApiKey: string | null;

  // Webhook
  webhookUrl: string | null;
  webhookEvents: string[];
}

export class ConfigError extends Error {}

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return v.trim();
}

function optionalStr(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function num(name: string, fallback: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new ConfigError(`${name} must be a number, got "${raw}"`);
  }
  if (min !== undefined && v < min) {
    throw new ConfigError(`${name} must be >= ${min}, got ${v}`);
  }
  if (max !== undefined && v > max) {
    throw new ConfigError(`${name} must be <= ${max}, got ${v}`);
  }
  return v;
}

/**
 * Strict boolean parse. Anything that is not an explicit affirmative is false.
 * This matters for ENABLE_REAL_TRADING: a typo must fail closed, never open.
 */
function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(
    `${name} must be true or false, got "${raw}". Refusing to guess on a safety flag.`,
  );
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  const accountTypeRaw = str('DERIV_ACCOUNT_TYPE', 'demo').toLowerCase();
  if (accountTypeRaw !== 'demo' && accountTypeRaw !== 'real') {
    throw new ConfigError(`DERIV_ACCOUNT_TYPE must be "demo" or "real", got "${accountTypeRaw}"`);
  }

  const appId = str('DERIV_APP_ID');
  const cfg: Config = {
    appId,
    accessToken: str('DERIV_ACCESS_TOKEN'),
    accountId: optionalStr('DERIV_ACCOUNT_ID'),
    accountType: accountTypeRaw,
    wsUrl: `wss://ws.derivws.com/websockets/v3?app_id=${encodeURIComponent(appId)}`,

    enableRealTrading: bool('ENABLE_REAL_TRADING', false),

    minSignalScore: num('MIN_SIGNAL_SCORE', 70, 0, 100),

    riskPerTradePercent: num('RISK_PER_TRADE_PERCENT', 1, 0.01, 100),
    maxTradesPerDay: num('MAX_TRADES_PER_DAY', 20, 1),
    maxOpenTrades: num('MAX_OPEN_TRADES', 2, 1),
    maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 3, 1),
    dailyLossLimitPercent: num('DAILY_LOSS_LIMIT_PERCENT', 5, 0.1, 100),
    maxDrawdownPercent: num('MAX_DRAWDOWN_PERCENT', 10, 0.1, 100),

    scanSymbols: list('SCAN_SYMBOLS', []),
    scanMarkets: list('SCAN_MARKETS', ['synthetic_index', 'forex']),
    maxScanSymbols: num('MAX_SCAN_SYMBOLS', 12, 1, 50),

    candleGranularity: num('CANDLE_GRANULARITY', 60, 60),
    candleCount: num('CANDLE_COUNT', 200, 60, 5000),
    scanIntervalSeconds: num('SCAN_INTERVAL_SECONDS', 60, 10),
    contractDuration: num('CONTRACT_DURATION', 5, 1),
    contractDurationUnit: str('CONTRACT_DURATION_UNIT', 'm'),
    emaFast: num('EMA_FAST', 9, 2),
    emaSlow: num('EMA_SLOW', 21, 3),
    emaTrend: num('EMA_TREND', 50, 5),
    rsiPeriod: num('RSI_PERIOD', 14, 2),
    atrPeriod: num('ATR_PERIOD', 14, 2),

    port: num('PORT', 8080, 1, 65535),
    nodeEnv: str('NODE_ENV', 'production'),
    adminApiKey: optionalStr('ADMIN_API_KEY'),

    webhookUrl: optionalStr('WEBHOOK_URL'),
    webhookEvents: list('WEBHOOK_EVENTS', ['signal', 'trade', 'halt']),
  };

  if (cfg.emaFast >= cfg.emaSlow) {
    throw new ConfigError(
      `EMA_FAST (${cfg.emaFast}) must be less than EMA_SLOW (${cfg.emaSlow})`,
    );
  }
  if (cfg.emaSlow >= cfg.emaTrend) {
    throw new ConfigError(
      `EMA_SLOW (${cfg.emaSlow}) must be less than EMA_TREND (${cfg.emaTrend})`,
    );
  }
  if (cfg.candleCount < cfg.emaTrend + cfg.atrPeriod + 10) {
    throw new ConfigError(
      `CANDLE_COUNT (${cfg.candleCount}) is too small for EMA_TREND ${cfg.emaTrend} + ATR_PERIOD ${cfg.atrPeriod}. ` +
        `Use at least ${cfg.emaTrend + cfg.atrPeriod + 10}.`,
    );
  }

  return cfg;
}

/**
 * Emits the loud warning banner when the bot is configured to spend real money,
 * so it can never happen quietly in a log nobody reads.
 */
export function announceTradingMode(cfg: Config, isVirtual: boolean, loginId: string): void {
  if (!cfg.enableRealTrading) {
    log.banner([
      'DRY RUN — ENABLE_REAL_TRADING is false',
      'Signals will be scored and recorded. No orders will be sent.',
      `Account: ${loginId} (${isVirtual ? 'demo' : 'REAL'})`,
    ]);
    return;
  }
  if (isVirtual) {
    log.banner([
      'LIVE EXECUTION on a DEMO account',
      'Orders will be sent to Deriv, but no real money is at risk.',
      `Account: ${loginId} (demo)`,
    ]);
    return;
  }
  log.banner([
    '*** REAL MONEY TRADING IS ARMED ***',
    'This bot will place live orders on a funded account.',
    `Account: ${loginId} (REAL)`,
    `Risk per trade: ${cfg.riskPerTradePercent}%  |  Daily loss limit: ${cfg.dailyLossLimitPercent}%`,
    `Max drawdown: ${cfg.maxDrawdownPercent}%  |  Max trades/day: ${cfg.maxTradesPerDay}`,
    'Set ENABLE_REAL_TRADING=false to disarm.',
  ]);
}

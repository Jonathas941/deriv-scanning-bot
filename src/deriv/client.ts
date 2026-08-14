import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { log } from '../logger';
import type {
  ActiveSymbol,
  AuthorizeResult,
  BuyResult,
  Candle,
  DerivResponse,
  OpenContract,
  ProposalResult,
} from './types';

const PING_INTERVAL_MS = 30_000; // Deriv drops idle sockets after ~2 minutes.
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_GAP_MS = 120; // crude client-side rate limiting
const MAX_BACKOFF_MS = 60_000;

export class DerivApiError extends Error {
  readonly code: string;
  constructor(message: string, code = 'UNKNOWN') {
    super(message);
    this.name = 'DerivApiError';
    this.code = code;
  }
}

interface Pending {
  resolve: (value: DerivResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  label: string;
}

/**
 * Thin, resilient wrapper over the Deriv v3 WebSocket API.
 *
 * Responsibilities:
 *  - keep a socket alive (ping + exponential-backoff reconnect)
 *  - correlate requests to responses via req_id
 *  - re-authorize automatically after a reconnect
 *  - surface subscription messages as events
 */
export class DerivClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string;

  private reqId = 0;
  private readonly pending = new Map<number, Pending>();

  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private lastSendAt = 0;

  private connecting: Promise<void> | null = null;
  private closed = false;

  private authorized: AuthorizeResult | null = null;

  constructor(url: string, token: string) {
    super();
    this.url = url;
    this.token = token;
  }

  get account(): AuthorizeResult | null {
    return this.authorized;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  async connect(): Promise<AuthorizeResult> {
    if (this.connecting) {
      await this.connecting;
      if (this.authorized) return this.authorized;
    }
    this.connecting = this.openSocket();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
    const auth = await this.authorize();
    return auth;
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      log.info('deriv: connecting');
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpenError = (err: Error) => {
        ws.removeAllListeners();
        reject(new DerivApiError(`WebSocket connection failed: ${err.message}`, 'CONNECT_FAILED'));
      };

      ws.once('error', onOpenError);

      ws.once('open', () => {
        ws.removeListener('error', onOpenError);
        this.reconnectAttempts = 0;
        this.startPing();

        ws.on('message', (data) => this.handleMessage(data));
        ws.on('error', (err) => log.warn('deriv: socket error', { error: err.message }));
        ws.on('close', (code, reason) => this.handleClose(code, reason.toString()));

        log.info('deriv: connected');
        this.emit('connected');
        resolve();
      });
    });
  }

  private handleClose(code: number, reason: string): void {
    this.stopPing();
    this.ws = null;
    this.authorized = null;

    // Fail every in-flight request so callers are never left hanging.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new DerivApiError(`Socket closed during "${p.label}"`, 'SOCKET_CLOSED'));
      this.pending.delete(id);
    }

    if (this.closed) return;

    log.warn('deriv: disconnected', { code, reason });
    this.emit('disconnected', { code, reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts += 1;
    log.info('deriv: reconnecting', { delayMs: delay, attempt: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect()
        .then(() => {
          log.info('deriv: reconnected and re-authorized');
          this.emit('reconnected');
        })
        .catch((err: Error) => {
          log.error('deriv: reconnect failed', { error: err.message });
          this.scheduleReconnect();
        });
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.isConnected) {
        this.send({ ping: 1 }).catch(() => {
          /* ping failures surface via close handler */
        });
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: DerivResponse;
    try {
      msg = JSON.parse(raw.toString()) as DerivResponse;
    } catch {
      log.warn('deriv: unparseable message');
      return;
    }

    // Subscription updates carry no req_id we are waiting on, or arrive
    // repeatedly for the same req_id. Emit them for listeners.
    if (msg.msg_type === 'proposal_open_contract') {
      this.emit('contract', msg.proposal_open_contract as OpenContract);
    }
    if (msg.msg_type === 'balance' && msg.balance) {
      this.emit('balance', msg.balance as { balance: number; currency: string });
    }

    const reqId = msg.req_id;
    if (typeof reqId !== 'number') return;

    const pending = this.pending.get(reqId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(reqId);

    if (msg.error) {
      pending.reject(new DerivApiError(msg.error.message, msg.error.code ?? 'API_ERROR'));
    } else {
      pending.resolve(msg);
    }
  }

  /** Send a request and await its correlated response. */
  async send(payload: Record<string, unknown>, label = 'request'): Promise<DerivResponse> {
    if (!this.isConnected) {
      throw new DerivApiError('Not connected to Deriv', 'NOT_CONNECTED');
    }

    // Space out requests slightly to stay clear of Deriv's rate limiter.
    const gap = Date.now() - this.lastSendAt;
    if (gap < MIN_REQUEST_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_REQUEST_GAP_MS - gap));
    }
    this.lastSendAt = Date.now();

    this.reqId += 1;
    const id = this.reqId;
    const body = { ...payload, req_id: id };

    return new Promise<DerivResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DerivApiError(`Timed out after ${REQUEST_TIMEOUT_MS}ms on "${label}"`, 'TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer, label });

      try {
        this.ws!.send(JSON.stringify(body));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new DerivApiError(`Send failed: ${(err as Error).message}`, 'SEND_FAILED'));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Typed API calls
  // -------------------------------------------------------------------------

  async authorize(): Promise<AuthorizeResult> {
    const res = await this.send({ authorize: this.token }, 'authorize');
    const auth = res.authorize as AuthorizeResult;
    this.authorized = auth;
    return auth;
  }

  async activeSymbols(): Promise<ActiveSymbol[]> {
    const res = await this.send(
      { active_symbols: 'brief', product_type: 'basic' },
      'active_symbols',
    );
    return (res.active_symbols as ActiveSymbol[]) ?? [];
  }

  async candles(symbol: string, granularity: number, count: number): Promise<Candle[]> {
    const res = await this.send(
      {
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: 'latest',
        granularity,
        style: 'candles',
      },
      `candles:${symbol}`,
    );
    const raw = (res.candles as Candle[]) ?? [];
    // Deriv occasionally returns string numerics; normalise defensively.
    return raw.map((c) => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      epoch: Number(c.epoch),
    }));
  }

  async balance(): Promise<{ balance: number; currency: string }> {
    const res = await this.send({ balance: 1 }, 'balance');
    return res.balance as { balance: number; currency: string };
  }

  async proposal(params: {
    symbol: string;
    contractType: string;
    amount: number;
    currency: string;
    duration: number;
    durationUnit: string;
  }): Promise<ProposalResult> {
    const res = await this.send(
      {
        proposal: 1,
        amount: Number(params.amount.toFixed(2)),
        basis: 'stake',
        contract_type: params.contractType,
        currency: params.currency,
        duration: params.duration,
        duration_unit: params.durationUnit,
        symbol: params.symbol,
      },
      `proposal:${params.symbol}`,
    );
    return res.proposal as ProposalResult;
  }

  /**
   * Buys a previously quoted proposal.
   * `maxPrice` is the ceiling we are willing to pay — Deriv rejects the buy if
   * the market moved above it, which protects against slippage.
   */
  async buy(proposalId: string, maxPrice: number): Promise<BuyResult> {
    const res = await this.send(
      { buy: proposalId, price: Number(maxPrice.toFixed(2)) },
      'buy',
    );
    return res.buy as BuyResult;
  }

  async subscribeOpenContract(contractId: number): Promise<void> {
    await this.send(
      { proposal_open_contract: 1, contract_id: contractId, subscribe: 1 },
      `track:${contractId}`,
    );
  }

  async portfolio(): Promise<OpenContract[]> {
    const res = await this.send({ portfolio: 1 }, 'portfolio');
    const p = res.portfolio as { contracts?: OpenContract[] } | undefined;
    return p?.contracts ?? [];
  }
}

import type { Config } from './config';
import { log } from './logger';

export type WebhookEvent = 'signal' | 'trade' | 'halt' | 'startup';

const TIMEOUT_MS = 8000;

/**
 * Fire-and-forget outbound notifier.
 *
 * Webhook delivery must never block or crash the trading loop, so every
 * failure is logged and swallowed. There is no retry queue by design: a stale
 * trading alert delivered late is worse than one that was dropped.
 */
export class Webhook {
  private readonly url: string | null;
  private readonly events: Set<string>;

  constructor(cfg: Config) {
    this.url = cfg.webhookUrl;
    this.events = new Set(cfg.webhookEvents);
  }

  get enabled(): boolean {
    return this.url !== null;
  }

  send(event: WebhookEvent, payload: Record<string, unknown>): void {
    if (!this.url || !this.events.has(event)) return;

    const body = JSON.stringify({
      event,
      at: new Date().toISOString(),
      source: 'deriv-scanning-bot',
      data: payload,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          log.warn('webhook: non-2xx response', { event, status: res.status });
        }
      })
      .catch((err: Error) => {
        log.warn('webhook: delivery failed', { event, error: err.message });
      })
      .finally(() => clearTimeout(timer));
  }
}

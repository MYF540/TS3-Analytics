import type { DbExecutor } from '../db/repositories/index.js';
import type { Logger } from '../logging/logger.js';
import { loadAlertSettings, type AlertEvent } from './settings.js';

const WINDOW_MS = 60_000;
const MAX_QUEUE = 200;
const MAX_LENGTH = 1900;
const TIMEOUT_MS = 10_000;

/** Escapes Discord markdown in player-controlled text (nicknames, ban reasons). */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#[\]()-])/g, '\\$1');
}

export interface NotifierDeps {
  db: DbExecutor;
  logger: Logger;
  fetch?: typeof fetch;
  /** Milliseconds. */
  now?: () => number;
}

export type SendResult = { ok: true } | { ok: false; status: number | null };

/**
 * Sends alerts to the Discord webhook from the settings (T5.4). At most `ratePerMinute` messages
 * per minute; what does not fit is summarised in the next free slot ("… und N weitere"). Mentions
 * are disabled, so nicknames like "@everyone" cannot ping anyone. The webhook URL is a secret and
 * never logged.
 */
export class AlertNotifier {
  private readonly sent: number[] = [];
  private readonly queue: string[] = [];
  private dropped = 0;
  private timer: NodeJS.Timeout | undefined;
  private sending = false;
  private pausedUntil = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: NotifierDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Queues a message if the event type is enabled and a webhook is configured. */
  notify(event: AlertEvent, text: string): void {
    const settings = loadAlertSettings(this.deps.db);
    if (!settings.webhookUrl || !settings.events.includes(event)) return;
    if (this.queue.length >= MAX_QUEUE) {
      this.dropped++;
    } else {
      this.queue.push(text);
    }
    void this.drain();
  }

  /** Sends a test message right away (outside the rate limit). */
  async sendTest(text: string): Promise<SendResult> {
    const { webhookUrl } = loadAlertSettings(this.deps.db);
    if (!webhookUrl) return { ok: false, status: null };
    return this.post(webhookUrl, text);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Messages waiting for a free slot (tests, status page). */
  get pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const now = this.now();
        while (this.sent.length > 0 && (this.sent[0] ?? 0) <= now - WINDOW_MS) this.sent.shift();
        const { webhookUrl, ratePerMinute } = loadAlertSettings(this.deps.db);
        if (!webhookUrl) {
          this.queue.length = 0;
          return;
        }
        const waitMs = Math.max(
          this.pausedUntil - now,
          this.sent.length >= ratePerMinute ? (this.sent[0] ?? now) + WINDOW_MS - now : 0,
        );
        if (waitMs > 0) {
          this.schedule(waitMs);
          return;
        }
        // Last free slot of the window and more waiting: send one summary instead.
        const lastSlot = this.sent.length === ratePerMinute - 1;
        const batch = lastSlot ? this.queue.splice(0) : this.queue.splice(0, 1);
        const text = summarise(batch, this.dropped);
        if (lastSlot) this.dropped = 0;
        this.sent.push(now);
        const result = await this.post(webhookUrl, text);
        if (!result.ok && result.status === 429) {
          // Try again after Discord's cool-down (set in post()).
          this.queue.unshift(text);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, ms);
  }

  private async post(url: string, text: string): Promise<SendResult> {
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)} …` : text,
          allowed_mentions: { parse: [] },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return { ok: true };
      if (response.status === 429) {
        const body = (await response.json().catch(() => ({}))) as { retry_after?: unknown };
        const retryS = typeof body.retry_after === 'number' ? body.retry_after : 5;
        this.pausedUntil = this.now() + Math.ceil(retryS * 1000);
      }
      this.deps.logger.warn({ status: response.status }, 'Discord alert rejected');
      return { ok: false, status: response.status };
    } catch (error) {
      // The error message may contain the URL; the logger scrubs webhook URLs from all text.
      this.deps.logger.warn({ err: error }, 'Discord alert failed');
      return { ok: false, status: null };
    }
  }
}

function summarise(batch: string[], dropped: number): string {
  const [first = '', ...rest] = batch;
  const more = rest.length + dropped;
  if (more === 0) return first;
  return `${first}\n… und ${String(more)} weitere Meldungen (gedrosselt, Details im Webinterface)`;
}

import type { AppDatabase } from '../db/client.js';
import type { Logger } from '../logging/logger.js';
import type { OnlineClient, TrackerListener } from '../watcher/tracker.js';
import { escapeMarkdown } from './notifier.js';
import type { AlertNotifier } from './notifier.js';
import { loadAlertSettings } from './settings.js';

const LISTED = 10;

/**
 * Join-spike detection (T5.5): counts joins of UIDs the bot has never seen before. When at least
 * `threshold` arrive within `windowMinutes`, one alert is sent; the next one earliest after
 * another window. Joins found by a client-list sync (start-up, missed events) do not count.
 */
export class JoinSpikeDetector implements TrackerListener {
  private readonly recent: { at: number; nickname: string }[] = [];
  private syncing = false;
  private lastAlertAt: number | undefined;

  constructor(
    private readonly database: AppDatabase,
    private readonly notifier: AlertNotifier,
    private readonly logger: Logger,
  ) {}

  onSyncStart(): void {
    this.syncing = true;
  }

  onSyncEnd(): void {
    this.syncing = false;
  }

  onJoined(client: OnlineClient, _source: unknown, at: number): void {
    if (this.syncing) return;
    const firstSeen = this.database.sqlite
      .prepare('SELECT first_seen FROM users WHERE id = ?')
      .pluck()
      .get(client.userId) as number | undefined;
    if (firstSeen !== at) return;

    const { windowMinutes, threshold } = loadAlertSettings(this.database.db).joinSpike;
    const windowS = windowMinutes * 60;
    this.recent.push({ at, nickname: client.nickname });
    while (this.recent.length > 0 && (this.recent[0]?.at ?? at) <= at - windowS)
      this.recent.shift();
    if (this.recent.length < threshold) return;
    if (this.lastAlertAt !== undefined && at - this.lastAlertAt < windowS) return;

    this.lastAlertAt = at;
    const names = this.recent.slice(-LISTED).map((r) => escapeMarkdown(r.nickname));
    const more = this.recent.length - names.length;
    this.logger.warn({ newUids: this.recent.length, windowMinutes }, 'Join spike detected');
    this.notifier.notify(
      'join.spike',
      `🚨 **Join-Spike:** ${String(this.recent.length)} neue Accounts in den letzten ${String(windowMinutes)} Minuten: ${names.join(', ')}${more > 0 ? ` (+${String(more)} weitere)` : ''}`,
    );
  }
}

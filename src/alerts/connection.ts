import type { Ts3Connection } from '../ts3/connection.js';
import { connectionLostAlert, connectionRestoredAlert } from './messages.js';
import type { AlertNotifier } from './notifier.js';

/** Short outages (restarts, reconnects) are normal; only longer ones are reported. */
export const OUTAGE_ALERT_AFTER_MS = 2 * 60_000;

/**
 * Reports when the bot has been without a query connection for a while, and when it is back
 * (T5.4). Also covers "never connected" after a start.
 */
export class ConnectionAlerts {
  private timer: NodeJS.Timeout | undefined;
  private downSince: number | undefined;
  private reported = false;
  private readonly onDisconnected = () => {
    this.startOutage();
  };
  private readonly onConnected = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.reported && this.downSince !== undefined) {
      this.notifier.notify(
        'bot.connection',
        connectionRestoredAlert(Math.round((this.now() - this.downSince) / 1000)),
      );
    }
    this.reported = false;
    this.downSince = undefined;
  };

  constructor(
    private readonly connection: Ts3Connection,
    private readonly notifier: AlertNotifier,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.connection.on('disconnected', this.onDisconnected);
    this.connection.on('connected', this.onConnected);
    if (!this.connection.isConnected) this.startOutage();
  }

  stop(): void {
    this.connection.off('disconnected', this.onDisconnected);
    this.connection.off('connected', this.onConnected);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private startOutage(): void {
    if (this.downSince !== undefined) return;
    this.downSince = this.now();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reported = true;
      this.notifier.notify('bot.connection', connectionLostAlert(OUTAGE_ALERT_AFTER_MS / 60_000));
    }, OUTAGE_ALERT_AFTER_MS);
  }
}

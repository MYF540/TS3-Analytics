import type Database from 'better-sqlite3';
import type { FlagDetectionResult } from '../jobs/flag-detection.js';
import type { BanSyncResult } from '../watcher/bans.js';
import { banAlert, flagAlert } from './messages.js';
import type { AlertNotifier } from './notifier.js';

/** New high/medium flags → alerts (not on the very first detection run). */
export function alertNewFlags(
  notifier: AlertNotifier,
  sqlite: Database.Database,
  result: FlagDetectionResult,
): void {
  if (result.initial) return;
  for (const flag of result.newFlags) {
    if (flag.level === 'high') notifier.notify('flag.high', flagAlert(sqlite, flag));
    else if (flag.level === 'medium') notifier.notify('flag.medium', flagAlert(sqlite, flag));
  }
}

/** New bans → alerts (not for the first mirror of an existing ban list). */
export function alertNewBans(
  notifier: AlertNotifier,
  sqlite: Database.Database,
  result: BanSyncResult,
): void {
  if (result.initial) return;
  for (const id of result.addedIds) {
    const text = banAlert(sqlite, id);
    if (text) notifier.notify('ban.added', text);
  }
}

import type Database from 'better-sqlite3';
import type { DbExecutor } from '../db/repositories/index.js';
import { automationLog, type AutomationModule, type AutomationResult } from '../db/schema.js';

/** How long entries of the automation log are kept. */
export const AUTOMATION_LOG_RETENTION_DAYS = 90;

/** Longest `detail` that is stored; longer texts are cut. */
const DETAIL_MAX = 300;

export interface AutomationEntry {
  at: number;
  module: AutomationModule;
  /** What happened, e.g. `kick` or `channel.create`. */
  action: string;
  userId?: number | undefined;
  /** Short text for humans. Never an IP address (rule 1). */
  detail?: string | undefined;
  result: AutomationResult;
}

export function writeAutomationLog(db: DbExecutor, entry: AutomationEntry): void {
  db.insert(automationLog)
    .values({
      at: entry.at,
      module: entry.module,
      action: entry.action,
      userId: entry.userId ?? null,
      detail: entry.detail === undefined ? null : entry.detail.slice(0, DETAIL_MAX),
      result: entry.result,
    })
    .run();
}

export interface AutomationLogRow {
  id: number;
  at: number;
  module: AutomationModule;
  action: string;
  userId: number | null;
  nickname: string | null;
  detail: string | null;
  result: AutomationResult;
}

/** Newest entries first, optionally of one module only. */
export function listAutomationLog(
  sqlite: Database.Database,
  options: { module?: AutomationModule | undefined; limit: number; offset: number },
): { items: AutomationLogRow[]; total: number } {
  const where = options.module === undefined ? '' : 'WHERE l.module = ?';
  const params = options.module === undefined ? [] : [options.module];
  const items = sqlite
    .prepare(
      `SELECT l.id, l.at, l.module, l.action, l.user_id AS userId,
              (SELECT n.nick FROM nicknames n WHERE n.user_id = l.user_id
               ORDER BY n.last_seen DESC, n.id DESC LIMIT 1) AS nickname,
              l.detail, l.result
       FROM automation_log l ${where}
       ORDER BY l.at DESC, l.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, options.limit, options.offset) as AutomationLogRow[];
  const { total } = sqlite
    .prepare(`SELECT count(*) AS total FROM automation_log l ${where}`)
    .get(...params) as { total: number };
  return { items, total };
}

/** Removes entries older than the retention period; returns how many. */
export function pruneAutomationLog(sqlite: Database.Database, now: number): number {
  return sqlite
    .prepare('DELETE FROM automation_log WHERE at < ?')
    .run(now - AUTOMATION_LOG_RETENTION_DAYS * 86_400).changes;
}

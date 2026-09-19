import { z } from 'zod';
import { escapeMarkdown, type AlertNotifier } from '../alerts/notifier.js';
import type { AppDatabase } from '../db/client.js';
import { getSetting, setSetting } from '../db/repositories/index.js';
import {
  lineLogPosition,
  logPosition,
  parseGroupChange,
  type GroupChange,
} from '../domain/group-log.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import { GROUP_LOG_POS_KEY, loadGroupWatch, saveGroupWatch } from './group-settings.js';

/** `logview` returns at most 100 lines per call. */
const LOG_LINES = 100;

export interface GroupWatchResult {
  /** New group changes stored. */
  stored: number;
  /** Changes of protected groups reported. */
  alerted: number;
  /** The log moved on by more than one page since the last poll: changes may be missing. */
  gap: boolean;
}

export interface GroupWatchDeps {
  database: AppDatabase;
  connection: Pick<Ts3Connection, 'logLines' | 'serverGroups' | 'isConnected' | 'on' | 'off'>;
  notifier: Pick<AlertNotifier, 'notify'>;
  logger: Logger;
  intervalS: number;
  now?: () => number;
}

function alertText(change: GroupChange, name: string): string {
  const group = escapeMarkdown(change.groupName);
  const verb =
    change.action === 'added'
      ? `wurde zur Gruppe „${group}“ hinzugefügt`
      : `wurde aus der Gruppe „${group}“ entfernt`;
  return `🛡️ **Geschützte Gruppe:** ${escapeMarkdown(name)} ${verb} (von ${escapeMarkdown(change.invokerName)}).`;
}

/**
 * Server-group watch (T5.7): reads the newest server log lines through the query queue, stores
 * group changes and alerts changes of protected groups. The first run only sets the position
 * (no alerts for history). Raw log lines are never stored or logged.
 */
export class GroupWatch {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<GroupWatchResult | undefined> | undefined;
  private failing = false;
  private readonly onConnected = () => {
    void this.refreshGroups();
    void this.poll();
  };

  constructor(private readonly deps: GroupWatchDeps) {}

  start(): void {
    this.deps.connection.on('connected', this.onConnected);
    this.timer = setInterval(() => {
      if (this.deps.connection.isConnected) void this.poll();
    }, this.deps.intervalS * 1000);
  }

  stop(): void {
    this.deps.connection.off('connected', this.onConnected);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stores the current group list for the settings page. */
  async refreshGroups(): Promise<void> {
    const { database, connection, logger } = this.deps;
    try {
      const groups = await connection.serverGroups();
      const settings = loadGroupWatch(database.db);
      saveGroupWatch(
        database.db,
        {
          ...settings,
          // Query groups (type 2) and templates (type 0) are not assigned to players.
          knownGroups: groups.filter((g) => g.type === 1).map((g) => ({ id: g.id, name: g.name })),
        },
        this.now(),
      );
    } catch (error) {
      logger.warn({ err: error }, 'Server group list could not be read');
    }
  }

  poll(): Promise<GroupWatchResult | undefined> {
    this.running ??= this.pollOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private async pollOnce(): Promise<GroupWatchResult | undefined> {
    const { database, connection, logger } = this.deps;
    let lines: string[];
    try {
      lines = await connection.logLines(LOG_LINES);
    } catch (error) {
      // Usually a missing permission (b_virtualserver_log_view); warn once until it works again.
      if (!this.failing) logger.warn({ err: error }, 'Server log could not be read');
      this.failing = true;
      return undefined;
    }
    this.failing = false;

    const positions = lines.map(lineLogPosition).filter((p): p is number => p !== undefined);
    const newest = positions.length > 0 ? Math.max(...positions) : undefined;
    const oldest = positions.length > 0 ? Math.min(...positions) : undefined;
    const lastPos = getSetting(database.db, GROUP_LOG_POS_KEY, z.number().int());
    const initial = lastPos === undefined;
    const gap = !initial && lines.length >= LOG_LINES && oldest !== undefined && oldest > lastPos;
    if (gap) logger.warn('Server log moved faster than polled; group changes may be missing');

    const changes = lines
      .map(parseGroupChange)
      .filter((c): c is GroupChange => c !== undefined)
      .filter((c) => initial || logPosition(c) > lastPos)
      .sort((a, b) => logPosition(a) - logPosition(b));

    const { protectedGroupIds } = loadGroupWatch(database.db);
    const userByDbid = database.sqlite.prepare(
      `SELECT u.id,
              (SELECT nick FROM nicknames n WHERE n.user_id = u.id ORDER BY n.last_seen DESC LIMIT 1)
                AS nick
       FROM users u WHERE u.dbid = ?`,
    );
    const insert = database.sqlite.prepare(
      `INSERT OR IGNORE INTO group_changes (at, log_pos, action, dbid, user_id, nickname, group_id,
         group_name, invoker_name, invoker_dbid, protected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const toAlert: string[] = [];
    const stored = database.sqlite.transaction(() => {
      let count = 0;
      for (const change of changes) {
        const user = userByDbid.get(change.dbid) as { id: number; nick: string | null } | undefined;
        const isProtected = protectedGroupIds.includes(change.groupId);
        const { changes: inserted } = insert.run(
          change.at,
          logPosition(change),
          change.action,
          change.dbid,
          user?.id ?? null,
          change.nickname ?? user?.nick ?? null,
          change.groupId,
          change.groupName,
          change.invokerName,
          change.invokerDbid,
          isProtected ? 1 : 0,
        );
        count += inserted;
        if (inserted > 0 && isProtected && !initial) {
          toAlert.push(
            alertText(change, change.nickname ?? user?.nick ?? `Client #${String(change.dbid)}`),
          );
        }
      }
      // Positions come from the server's own timestamps, so its clock never matters.
      if (newest !== undefined) {
        setSetting(database.db, GROUP_LOG_POS_KEY, Math.max(lastPos ?? 0, newest), this.now());
      }
      return count;
    })();

    for (const text of toAlert) this.deps.notifier.notify('group.protected', text);
    if (toAlert.length > 0) logger.warn({ changes: toAlert.length }, 'Protected group changed');
    return { stored, alerted: toAlert.length, gap };
  }
}

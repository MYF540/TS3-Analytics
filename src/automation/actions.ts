import type { AppDatabase } from '../db/client.js';
import type { AutomationModule } from '../db/schema.js';
import { scrubIps, type Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import { writeAutomationLog } from './log.js';

/** The query commands bot modules may use; `Ts3Connection` runs them through the queue. */
export type AutomationCommands = Pick<
  Ts3Connection,
  | 'kick'
  | 'poke'
  | 'sendMessage'
  | 'move'
  | 'banClient'
  | 'addToServerGroup'
  | 'removeFromServerGroup'
  | 'channelEdit'
>;

/** Limits of the TS3 server for texts sent to clients. */
export const KICK_REASON_MAX = 40;
export const POKE_MAX = 100;
export const MESSAGE_MAX = 1024;
export const BAN_REASON_MAX = 80;

/** The client an action is aimed at. */
export interface ActionTarget {
  clid: number;
  userId: number;
  dbid: number;
}

/** A module tried to touch a server group it does not own (rule 13). */
export class ForeignGroupError extends Error {
  constructor(
    readonly module: AutomationModule,
    readonly groupId: number,
  ) {
    super(`Module "${module}" may not touch server group ${String(groupId)}`);
    this.name = 'ForeignGroupError';
  }
}

export interface AutomationDeps {
  database: AppDatabase;
  commands: AutomationCommands;
  logger: Logger;
  /** UTC seconds. */
  now: () => number;
}

export interface ActionScope {
  module: AutomationModule;
  /** Test mode: record what would happen, send nothing (rule 7). */
  dryRun: boolean;
  /** Server groups from the module's own configuration; no other group may be changed. */
  ownGroupIds?: readonly number[];
}

/** Server groups of the rank ladder; they belong to the rank job alone (rule 6). */
export function rankGroupIds(database: AppDatabase): Set<number> {
  const rows = database.sqlite.prepare('SELECT server_group_id AS id FROM ranks').all() as {
    id: number;
  }[];
  return new Set(rows.map((row) => row.id));
}

/**
 * Everything a bot module does on the server goes through here: the action is written to the
 * automation log, test mode stops it before any query command, and server groups are only
 * changed when the module's configuration names them and the rank ladder does not.
 * A failing command is logged and recorded, it never throws into the module.
 */
export class ModuleActions {
  constructor(
    private readonly deps: AutomationDeps,
    private readonly scope: ActionScope,
  ) {}

  get dryRun(): boolean {
    return this.scope.dryRun;
  }

  message(target: ActionTarget, text: string, detail?: string): Promise<boolean> {
    const message = text.slice(0, MESSAGE_MAX);
    return this.run('message', target, detail, (c) => c.sendMessage(target.clid, message));
  }

  poke(target: ActionTarget, text: string, detail?: string): Promise<boolean> {
    const message = text.slice(0, POKE_MAX);
    return this.run('poke', target, detail, (c) => c.poke(target.clid, message));
  }

  kick(target: ActionTarget, reason: string, detail?: string): Promise<boolean> {
    const text = reason.slice(0, KICK_REASON_MAX);
    return this.run('kick', target, detail ?? reason, (c) => c.kick(target.clid, 'server', text));
  }

  kickFromChannel(target: ActionTarget, reason: string, detail?: string): Promise<boolean> {
    const text = reason.slice(0, KICK_REASON_MAX);
    return this.run('kick.channel', target, detail ?? reason, (c) =>
      c.kick(target.clid, 'channel', text),
    );
  }

  /** Temporary ban of UID and current IP. `durationS` must be positive: modules never ban forever. */
  ban(target: ActionTarget, durationS: number, reason: string, detail?: string): Promise<boolean> {
    if (!Number.isInteger(durationS) || durationS <= 0) {
      throw new RangeError('Automatic bans need a positive duration');
    }
    const text = reason.slice(0, BAN_REASON_MAX);
    return this.run('ban', target, detail ?? `${String(durationS)} s: ${reason}`, (c) =>
      c.banClient(target.clid, durationS, text),
    );
  }

  move(target: ActionTarget, channelId: number, detail?: string): Promise<boolean> {
    return this.run('move', target, detail, (c) => c.move(target.clid, channelId));
  }

  addGroup(target: ActionTarget, groupId: number, detail?: string): Promise<boolean> {
    this.assertOwnGroup(groupId);
    return this.run('group.add', target, detail ?? `Gruppe ${String(groupId)}`, (c) =>
      c.addToServerGroup(target.dbid, groupId),
    );
  }

  removeGroup(target: ActionTarget, groupId: number, detail?: string): Promise<boolean> {
    this.assertOwnGroup(groupId);
    return this.run('group.remove', target, detail ?? `Gruppe ${String(groupId)}`, (c) =>
      c.removeFromServerGroup(target.dbid, groupId),
    );
  }

  /** Records something the module noticed without acting on the server. */
  note(action: string, target: ActionTarget | undefined, detail?: string): void {
    this.record(action, target, detail, this.scope.dryRun ? 'dry' : 'done');
  }

  /**
   * Runs any other query command under the same rules (log entry, test mode, errors caught).
   * Returns true when the command was really sent and succeeded.
   */
  async run(
    action: string,
    target: ActionTarget | undefined,
    detail: string | undefined,
    command: (commands: AutomationCommands) => Promise<unknown>,
  ): Promise<boolean> {
    if (this.scope.dryRun) {
      this.record(action, target, detail, 'dry');
      return false;
    }
    try {
      await command(this.deps.commands);
    } catch (error) {
      this.deps.logger.warn(
        { err: error, module: this.scope.module, action },
        'Automation action failed',
      );
      const reason = error instanceof Error ? scrubIps(error.message) : 'unknown error';
      this.record(action, target, detail ? `${detail} – ${reason}` : reason, 'failed');
      return false;
    }
    this.record(action, target, detail, 'done');
    return true;
  }

  private assertOwnGroup(groupId: number): void {
    const own = this.scope.ownGroupIds ?? [];
    if (!own.includes(groupId) || rankGroupIds(this.deps.database).has(groupId)) {
      throw new ForeignGroupError(this.scope.module, groupId);
    }
  }

  private record(
    action: string,
    target: ActionTarget | undefined,
    detail: string | undefined,
    result: 'done' | 'dry' | 'failed',
  ): void {
    writeAutomationLog(this.deps.database.db, {
      at: this.deps.now(),
      module: this.scope.module,
      action,
      userId: target?.userId,
      detail,
      result,
    });
  }
}

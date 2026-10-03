import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import {
  dedupeGroups,
  renderStaffList,
  type StaffGroup,
  type StaffStatus,
} from '../../domain/staff-list.js';
import type { Ts3GroupMember } from '../../ts3/types.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import { loadActivitySettings } from '../../watcher/settings.js';
import { ModuleActions, type AutomationDeps } from '../actions.js';
import type { BotClient, BotModule } from '../host.js';
import { loadModuleSettings, moduleBase } from '../settings.js';

const line = (max: number) => z.string().max(max);

export const staffSettingsSchema = moduleBase.extend({
  /** The channel whose description shows the list. */
  channelId: z.number().int().positive().nullable().default(null),
  /** Server groups in the order they are listed; `title` defaults to the group's name. */
  groups: z
    .array(
      z.object({
        groupId: z.number().int().positive(),
        title: line(200).trim().default(''),
      }),
    )
    .max(20)
    .default([]),
  /** Show a member of several groups in each of them instead of only the first. */
  showInAll: z.boolean().default(false),
  /** Someone in an AFK channel counts as away instead of online. */
  awayInAfkChannel: z.boolean().default(true),
  header: line(2000).default(''),
  footer: line(2000).default(''),
  groupLine: line(200).default('[b]{group}[/b]'),
  memberLine: line(200).default('{name} – {status}'),
  online: line(100).default('[color=#2e9e44]online[/color]'),
  away: line(100).default('[color=#b58900]abwesend[/color]'),
  offline: line(100).default('[color=#8a8a8a]offline[/color]'),
  empty: line(200).default('[i]niemand[/i]'),
  hideEmptyGroups: z.boolean().default(false),
  clickable: z.boolean().default(true),
});

export type StaffSettings = z.infer<typeof staffSettingsSchema>;

export function loadStaffSettings(db: DbExecutor): StaffSettings {
  return loadModuleSettings(db, 'staff', staffSettingsSchema);
}

/** How long the member lists of the groups are reused before they are fetched again. */
export const MEMBERS_TTL_S = 300;
/** Shortest time between two writes of the description. */
export const WRITE_INTERVAL_S = 30;

export interface StaffDeps extends AutomationDeps {
  online: () => readonly BotClient[];
  /** Reads the members of a server group (one query command per group). */
  members: (groupId: number) => Promise<Ts3GroupMember[]>;
}

/**
 * Staff list (T10.5): keeps the description of one channel showing who of the team is online.
 * The member lists are fetched every few minutes, the status comes from the live view; the
 * description is only written when its text changed, and not more often than every 30 seconds.
 */
export class StaffModule implements BotModule {
  readonly id = 'staff';
  private members = new Map<number, Ts3GroupMember[]>();
  private membersAt: number | undefined;
  private membersKey = '';
  /** Text last written (or, in test mode, last recorded). */
  private written: string | undefined;
  private writtenAt: number | undefined;
  private refreshing: Promise<void> | undefined;
  /** The settings the state above belongs to; new settings start from scratch. */
  private settingsKey = '';

  constructor(private readonly deps: StaffDeps) {}

  onJoin(): Promise<void> {
    return this.refresh();
  }

  onLeft(): Promise<void> {
    return this.refresh();
  }

  onMoved(): Promise<void> {
    return this.refresh();
  }

  onSynced(): Promise<void> {
    return this.refresh();
  }

  /** One refresh at a time; calls arriving meanwhile share the running one. */
  refresh(): Promise<void> {
    this.refreshing ??= this.refreshOnce().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadStaffSettings(db);
    const { channelId } = settings;
    if (!settings.enabled || channelId === null || settings.groups.length === 0) return;
    const now = this.deps.now();
    const settingsKey = JSON.stringify(settings);
    if (settingsKey !== this.settingsKey) {
      this.settingsKey = settingsKey;
      this.membersAt = undefined;
      this.written = undefined;
      this.writtenAt = undefined;
    }
    await this.loadMembers(settings, now);

    const text = renderStaffList(this.groups(settings), settings);
    if (text === this.written) return;
    // Too soon after the last write: the next poll picks the change up.
    if (this.writtenAt !== undefined && now - this.writtenAt < WRITE_INTERVAL_S) return;
    this.written = text;
    this.writtenAt = now;
    await new ModuleActions(this.deps, { module: this.id, dryRun: settings.dryRun }).run(
      'staff.update',
      undefined,
      `${String(text.length)} Zeichen`,
      (commands) => commands.channelEdit(channelId, { description: text }),
    );
  }

  private async loadMembers(settings: StaffSettings, now: number): Promise<void> {
    const key = settings.groups.map((group) => group.groupId).join(',');
    const fresh = this.membersAt !== undefined && now - this.membersAt < MEMBERS_TTL_S;
    if (fresh && key === this.membersKey) return;
    const next = new Map<number, Ts3GroupMember[]>();
    for (const { groupId } of settings.groups) next.set(groupId, await this.deps.members(groupId));
    this.members = next;
    this.membersAt = now;
    this.membersKey = key;
  }

  private groups(settings: StaffSettings): StaffGroup[] {
    const { db } = this.deps.database;
    const afk = settings.awayInAfkChannel ? loadActivitySettings(db).afkChannelIds : [];
    const online = this.deps.online();
    const names = new Map(loadGroupWatch(db).knownGroups.map((group) => [group.id, group.name]));

    const groups = settings.groups.map(({ groupId, title }) => {
      const listed = new Map(
        (this.members.get(groupId) ?? []).map((member) => [member.uid, member.nickname]),
      );
      // Someone who got the group since the last fetch is online with it already.
      for (const client of online) {
        if (client.serverGroups.includes(groupId)) listed.set(client.uid, client.nickname);
      }
      const members = [...listed].map(([uid, nickname]) => {
        const live = online.filter((client) => client.uid === uid);
        const status: StaffStatus =
          live.length === 0
            ? 'offline'
            : live.every((client) => afk.includes(client.channelId))
              ? 'away'
              : 'online';
        // The live nickname is newer than the one the server stored at the last disconnect.
        return { uid, nickname: live[0]?.nickname ?? nickname, status };
      });
      return { title: title || names.get(groupId) || `Gruppe ${String(groupId)}`, members };
    });
    return dedupeGroups(groups, settings.showInAll);
  }
}

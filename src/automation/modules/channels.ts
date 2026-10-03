import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import {
  CHANNEL_NAME_MAX,
  planPool,
  type PoolChannel,
  type PoolNaming,
} from '../../domain/channel-pool.js';
import type { Ts3Channel } from '../../ts3/types.js';
import { ModuleActions, type AutomationDeps } from '../actions.js';
import type { BotClient, BotModule } from '../host.js';
import { addManaged, listManaged, removeManaged } from '../managed-channels.js';
import { loadModuleSettings, moduleBase } from '../settings.js';

const name = z.string().trim().min(1).max(CHANNEL_NAME_MAX);

export const channelArea = z.object({
  /** Stable key of the area; managed channels are filed under it. */
  id: z.string().regex(/^[\w-]{1,32}$/),
  /** The channel below which the area's channels live. */
  parentId: z.number().int().positive(),
  naming: z.enum(['numbered', 'list']).default('numbered'),
  /** Numbered naming: "Talk" gives "Talk 1", "Talk 2", … */
  prefix: z
    .string()
    .trim()
    .max(CHANNEL_NAME_MAX - 5)
    .default(''),
  /** List naming: the names to use, in this order. */
  names: z.array(name).max(50).default([]),
  /** Empty channels that should always be there. */
  minFree: z.number().int().min(1).max(5).default(1),
  maxChannels: z.number().int().min(1).max(50).default(20),
  /** -1 = unlimited. */
  maxClients: z.number().int().min(-1).max(1000).default(-1),
  codecQuality: z.number().int().min(0).max(10).default(6),
  /** 0 leaves the server default. */
  joinPower: z.number().int().min(0).max(1_000_000).default(0),
  talkPower: z.number().int().min(0).max(1_000_000).default(0),
  description: z.string().max(2000).default(''),
});

export type ChannelArea = z.infer<typeof channelArea>;

export const channelsSettingsSchema = moduleBase.extend({
  areas: z.array(channelArea).max(20).default([]),
});

export type ChannelsSettings = z.infer<typeof channelsSettingsSchema>;

export function loadChannelsSettings(db: DbExecutor): ChannelsSettings {
  return loadModuleSettings(db, 'channels', channelsSettingsSchema);
}

export function areaNaming(area: ChannelArea): PoolNaming {
  return area.naming === 'list'
    ? { kind: 'list', names: area.names }
    : { kind: 'numbered', prefix: area.prefix };
}

/** What is wrong with an area's naming, if anything. */
export function areaProblem(area: ChannelArea): 'prefix' | 'names' | undefined {
  if (area.naming === 'numbered') return area.prefix === '' ? 'prefix' : undefined;
  return area.names.length === 0 || new Set(area.names).size !== area.names.length
    ? 'names'
    : undefined;
}

/** Children of an area's parent as the planner wants them. */
export function poolChildren(
  channels: readonly Ts3Channel[],
  area: ChannelArea,
  managed: ReadonlySet<number>,
  occupancy: (cid: number, listed: number) => number,
): PoolChannel[] {
  return channels
    .filter((channel) => channel.pid === area.parentId)
    .map((channel) => ({
      cid: channel.cid,
      name: channel.name,
      order: channel.order,
      clients: occupancy(channel.cid, channel.totalClients),
      managed: managed.has(channel.cid),
    }));
}

export interface ChannelsDeps extends AutomationDeps {
  online: () => readonly BotClient[];
  /** The server's channel list (one query command). */
  channels: () => Promise<Ts3Channel[]>;
}

/**
 * Channel creator (T10.6): below each configured parent there are always `minFree` empty
 * channels of the area's naming scheme; surplus empty ones are removed. The module only ever
 * deletes channels recorded in `managed_channels` (rule 13).
 *
 * The channel list is read once per poll; between polls the module works on that copy and the
 * live view of who is where, so a busy server does not cost a query per channel switch.
 */
export class ChannelsModule implements BotModule {
  readonly id = 'channels';
  private snapshot: Ts3Channel[] | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  /** Last plan recorded in test mode, so the log gets one entry per change, not per poll. */
  private dryPlan = '';

  constructor(private readonly deps: ChannelsDeps) {}

  onJoin(client: BotClient): Promise<void> {
    return this.touched([client.channelId]);
  }

  onMoved(client: BotClient, previousChannelId: number): Promise<void> {
    return this.touched([client.channelId, previousChannelId]);
  }

  onLeft(client: BotClient): Promise<void> {
    return this.touched([client.channelId]);
  }

  async onSynced(): Promise<void> {
    const settings = loadChannelsSettings(this.deps.database.db);
    if (!settings.enabled || settings.areas.length === 0) {
      this.snapshot = undefined;
      return;
    }
    this.snapshot = await this.deps.channels();
    this.forgetVanished(this.snapshot);
    await this.reconcile();
  }

  /** Reconciles when one of the channels belongs to an area; otherwise nothing changes. */
  private touched(channelIds: readonly number[]): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return Promise.resolve();
    const parents = new Set(
      loadChannelsSettings(this.deps.database.db).areas.map((area) => area.parentId),
    );
    const relevant = channelIds.some((cid) => {
      const channel = snapshot.find((entry) => entry.cid === cid);
      return channel !== undefined && parents.has(channel.pid);
    });
    return relevant ? this.reconcile() : Promise.resolve();
  }

  /** One run at a time; a trigger arriving meanwhile causes exactly one more run. */
  private reconcile(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.reconcileOnce();
      } while (this.wantsRerun());
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** A method (not an inline read) because the flag changes across `await`. */
  private wantsRerun(): boolean {
    return this.again;
  }

  /** Drops records of channels somebody deleted on the server. */
  private forgetVanished(channels: readonly Ts3Channel[]): void {
    const { db } = this.deps.database;
    const existing = new Set(channels.map((channel) => channel.cid));
    for (const entry of listManaged(db, 'channels')) {
      if (!existing.has(entry.channelId)) removeManaged(db, entry.channelId);
    }
  }

  private async reconcileOnce(): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadChannelsSettings(db);
    const snapshot = this.snapshot;
    if (!settings.enabled || !snapshot) return;
    const actions = new ModuleActions(this.deps, { module: this.id, dryRun: settings.dryRun });
    const online = this.deps.online();
    // The live view knows about moves the snapshot has not seen yet.
    const occupancy = (cid: number) => online.filter((client) => client.channelId === cid).length;
    const dryPlan: string[] = [];

    for (const area of settings.areas) {
      if (areaProblem(area) || !snapshot.some((channel) => channel.cid === area.parentId)) continue;
      const managed = new Set(listManaged(db, 'channels', area.id).map((e) => e.channelId));
      const children = poolChildren(snapshot, area, managed, occupancy);
      const plan = planPool(children, {
        naming: areaNaming(area),
        minFree: area.minFree,
        maxChannels: area.maxChannels,
      });
      if (settings.dryRun) {
        dryPlan.push(`${area.id}:+${plan.create.map((c) => c.name).join(',')}`);
        dryPlan.push(`${area.id}:-${plan.delete.join(',')}`);
        continue;
      }
      for (const cid of plan.delete) await this.remove(actions, snapshot, cid);
      for (const entry of plan.create) await this.create(actions, snapshot, area, entry);
    }

    if (!settings.dryRun) return;
    const key = dryPlan.join('|');
    if (key === this.dryPlan) return;
    this.dryPlan = key;
    for (const line of dryPlan) {
      const [, change = ''] = line.split(':');
      if (change.length > 1) {
        actions.note(
          change.startsWith('+') ? 'channel.create' : 'channel.delete',
          undefined,
          change.slice(1),
        );
      }
    }
  }

  private async create(
    actions: ModuleActions,
    snapshot: Ts3Channel[],
    area: ChannelArea,
    entry: { name: string; order: number },
  ): Promise<void> {
    const { db } = this.deps.database;
    let cid: number | undefined;
    const created = await actions.run('channel.create', undefined, entry.name, async (commands) => {
      cid = await commands.channelCreate({
        name: entry.name,
        parentId: area.parentId,
        kind: 'permanent',
        order: entry.order,
        maxClients: area.maxClients,
        codecQuality: area.codecQuality,
        ...(area.description === '' ? {} : { description: area.description }),
      });
    });
    if (!created || cid === undefined) return;
    const channelId = cid;
    addManaged(db, { channelId, module: 'channels', scope: area.id, createdAt: this.deps.now() });
    snapshot.push({
      cid: channelId,
      pid: area.parentId,
      name: entry.name,
      order: entry.order,
      totalClients: 0,
      maxClients: area.maxClients,
      kind: 'permanent',
      hasPassword: false,
    });
    const permissions: [string, number][] = [
      ['i_channel_needed_join_power', area.joinPower],
      ['i_client_needed_talk_power', area.talkPower],
    ];
    for (const [permission, value] of permissions) {
      if (value === 0) continue;
      await actions.run(
        'channel.permission',
        undefined,
        `${entry.name}: ${permission}`,
        (commands) => commands.channelSetPermission(channelId, permission, value),
      );
    }
  }

  private async remove(actions: ModuleActions, snapshot: Ts3Channel[], cid: number): Promise<void> {
    const index = snapshot.findIndex((channel) => channel.cid === cid);
    const label = snapshot[index]?.name ?? String(cid);
    // Not forced: if somebody slipped in meanwhile, the server refuses and the channel stays.
    const deleted = await actions.run('channel.delete', undefined, label, (commands) =>
      commands.channelDelete(cid, false),
    );
    if (!deleted) return;
    removeManaged(this.deps.database.db, cid);
    if (index !== -1) snapshot.splice(index, 1);
  }
}

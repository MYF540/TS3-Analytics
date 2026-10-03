import { z } from 'zod';
import type { AlertNotifier } from '../../alerts/notifier.js';
import { escapeMarkdown } from '../../alerts/notifier.js';
import { getChannelName, upsertChannels, type DbExecutor } from '../../db/repositories/index.js';
import { availableSupporters, Cooldown, fillTemplate } from '../../domain/support.js';
import { loadActivitySettings } from '../../watcher/settings.js';
import { MESSAGE_MAX, ModuleActions, POKE_MAX, type AutomationDeps } from '../actions.js';
import type { BotClient, BotModule } from '../host.js';
import { isExempt, loadModuleSettings, moduleBase } from '../settings.js';

/** TS3 limit for channel names. */
const CHANNEL_NAME_MAX = 40;

const channelName = z.string().trim().min(1).max(CHANNEL_NAME_MAX);

export const supportSettingsSchema = moduleBase.extend({
  /** The channel players enter to ask for help. */
  channelId: z.number().int().positive().nullable().default(null),
  /** Members of these server groups are the team: they are told, and never ask themselves. */
  supporterGroupIds: z.array(z.number().int().positive()).max(50).default([]),
  /** How the team is told. */
  notify: z.enum(['poke', 'message']).default('poke'),
  /** `{name}` is the nickname of the player who asks. */
  supporterMessage: z.string().trim().min(1).max(POKE_MAX).default('{name} wartet im Support.'),
  userMessage: z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_MAX)
    .default('Hallo {name}, das Team wurde informiert und kümmert sich gleich um dich.'),
  nobodyMessage: z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_MAX)
    .default('Hallo {name}, im Moment ist leider niemand vom Team erreichbar.'),
  /** Seconds before the same player triggers a notification again. */
  cooldownS: z.number().int().min(0).max(3600).default(60),
  /** Rename and (un)lock the channel depending on whether somebody of the team is available. */
  autoOpen: z
    .object({
      enabled: z.boolean().default(false),
      openName: channelName.default('Support [offen]'),
      closedName: channelName.default('Support [geschlossen]'),
      /** Client limit while open; -1 = unlimited. */
      openMaxClients: z.number().int().min(-1).max(1000).default(-1),
      /** Client limit while closed; 0 locks the channel. */
      closedMaxClients: z.number().int().min(-1).max(1000).default(0),
    })
    .default({
      enabled: false,
      openName: 'Support [offen]',
      closedName: 'Support [geschlossen]',
      openMaxClients: -1,
      closedMaxClients: 0,
    }),
});

export type SupportSettings = z.infer<typeof supportSettingsSchema>;

export function loadSupportSettings(db: DbExecutor): SupportSettings {
  return loadModuleSettings(db, 'support', supportSettingsSchema);
}

export interface SupportDeps extends AutomationDeps {
  /** Who is online, as the automation host sees it. */
  online: () => readonly BotClient[];
  notifier: Pick<AlertNotifier, 'notify'>;
}

/**
 * Support channel (T10.4): whoever enters it is greeted, and the available team members are
 * poked or messaged. Optionally the channel is renamed and locked while nobody is available.
 */
export class SupportModule implements BotModule {
  readonly id = 'support';
  private readonly cooldown = new Cooldown();
  /** Open/closed state last sent to the server, so nothing is sent without a change. */
  private applied: 'open' | 'closed' | undefined;

  constructor(private readonly deps: SupportDeps) {}

  async onJoin(client: BotClient, info: { discovered: boolean }, at: number): Promise<void> {
    // Someone found in the channel at start-up asked before we were listening; leave them be.
    if (!info.discovered) await this.request(client, at);
    await this.updateChannel();
  }

  async onMoved(client: BotClient, _previous: number, _cause: unknown, at: number): Promise<void> {
    await this.request(client, at);
    await this.updateChannel();
  }

  onLeft(): Promise<void> {
    return this.updateChannel();
  }

  /** Server groups only change with a poll, so availability is checked again after each one. */
  onSynced(): Promise<void> {
    return this.updateChannel();
  }

  private supporters(settings: SupportSettings): BotClient[] {
    return availableSupporters(this.deps.online(), {
      supporterGroupIds: settings.supporterGroupIds,
      afkChannelIds: loadActivitySettings(this.deps.database.db).afkChannelIds,
    });
  }

  private actions(settings: SupportSettings): ModuleActions {
    return new ModuleActions(this.deps, { module: this.id, dryRun: settings.dryRun });
  }

  private async request(client: BotClient, at: number): Promise<void> {
    const settings = loadSupportSettings(this.deps.database.db);
    if (!settings.enabled || client.channelId !== settings.channelId) return;
    const isTeam = client.serverGroups.some((g) => settings.supporterGroupIds.includes(g));
    if (isTeam || isExempt(settings, client.serverGroups)) return;
    if (!this.cooldown.allow(client.userId, at, settings.cooldownS)) return;

    const actions = this.actions(settings);
    const values = { name: client.nickname };
    const team = this.supporters(settings);
    if (team.length === 0) {
      await actions.message(client, fillTemplate(settings.nobodyMessage, values), 'niemand da');
      return;
    }
    await actions.message(client, fillTemplate(settings.userMessage, values));
    const text = fillTemplate(settings.supporterMessage, values);
    const detail = `Anfrage von „${client.nickname}“`;
    for (const supporter of team) {
      if (settings.notify === 'poke') await actions.poke(supporter, text, detail);
      else await actions.message(supporter, text, detail);
    }
    if (!settings.dryRun) {
      this.deps.notifier.notify(
        'support.request',
        `🛟 **Support:** ${escapeMarkdown(client.nickname)} wartet im Support-Channel.`,
      );
    }
  }

  private async updateChannel(): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadSupportSettings(db);
    const { channelId, autoOpen } = settings;
    if (!settings.enabled || !autoOpen.enabled || channelId === null) {
      this.applied = undefined;
      return;
    }
    const state = this.supporters(settings).length > 0 ? 'open' : 'closed';
    if (state === this.applied) return;
    // Claimed before the command runs, so events arriving meanwhile do not send it twice.
    this.applied = state;

    const name = state === 'open' ? autoOpen.openName : autoOpen.closedName;
    const maxClients = state === 'open' ? autoOpen.openMaxClients : autoOpen.closedMaxClients;
    // The server rejects a rename to the name a channel already has.
    const rename = getChannelName(db, channelId) !== name;
    const sent = await this.actions(settings).run(
      state === 'open' ? 'support.open' : 'support.close',
      undefined,
      name,
      (commands) => commands.channelEdit(channelId, { ...(rename ? { name } : {}), maxClients }),
    );
    // Keep our copy of the name current; the next poll may be a minute away.
    if (sent && rename) upsertChannels(db, [{ id: channelId, name, seenAt: this.deps.now() }]);
  }
}

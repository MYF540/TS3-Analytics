import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import { CHANNEL_NAME_MAX } from '../../domain/channel-pool.js';
import { Cooldown, fillTemplate } from '../../domain/support.js';
import type { Ts3Channel } from '../../ts3/types.js';
import { MESSAGE_MAX, ModuleActions, type AutomationDeps } from '../actions.js';
import type { BotClient, BotModule, JoinInfo } from '../host.js';
import { clientLanguage, englishSection } from '../language.js';
import { addManaged, listManaged, removeManaged } from '../managed-channels.js';
import { isExempt, loadModuleSettings, moduleBase } from '../settings.js';

/** Longest delete delay offered: 31 days. */
export const DELETE_DELAY_MAX_S = 31 * 86_400;

const text = z.string().trim().min(1).max(MESSAGE_MAX);

export const privateLobby = z.object({
  /** Stable key; a player's channel is filed under it. */
  id: z.string().regex(/^[\w-]{1,32}$/),
  /** Entering this channel asks for a private channel. */
  lobbyChannelId: z.number().int().positive(),
  /** The private channels are created below this channel. */
  parentId: z.number().int().positive(),
  /** `{name}` is the player's nickname. */
  nameTemplate: z.string().trim().min(1).max(CHANNEL_NAME_MAX).default('Privater Raum von {name}'),
  /** Channel group the owner gets in their channel (e.g. channel admin); null = none. */
  channelGroupId: z.number().int().positive().nullable().default(null),
  kind: z.enum(['temporary', 'semi', 'permanent']).default('temporary'),
  /** Temporary channels: seconds an empty channel survives. */
  deleteDelayS: z.number().int().min(0).max(DELETE_DELAY_MAX_S).default(300),
  description: z.string().max(2000).default(''),
  /** -1 = unlimited. */
  maxClients: z.number().int().min(-1).max(1000).default(-1),
  codecQuality: z.number().int().min(0).max(10).default(6),
  /** Protect the channel with a generated password and tell the owner. */
  password: z.boolean().default(false),
  /** Only members of these server groups get a channel; empty = everybody. */
  allowedGroupIds: z.array(z.number().int().positive()).max(100).default([]),
});

export type PrivateLobby = z.infer<typeof privateLobby>;

export const privateSettingsSchema = moduleBase.extend({
  lobbies: z.array(privateLobby).max(10).default([]),
  /** Seconds before the same player can have another channel created. */
  cooldownS: z.number().int().min(0).max(3600).default(30),
  createdMessage: text.default('Dein privater Channel wurde angelegt.'),
  movedMessage: text.default('Willkommen zurück in deinem privaten Channel.'),
  deniedMessage: text.default('Du kannst hier keinen privaten Channel bekommen.'),
  /** `{password}` is the generated password. */
  passwordMessage: text.default('Das Passwort deines Channels lautet: {password}'),
  /** English texts for players outside the German-speaking countries (T12.1). */
  english: englishSection({
    createdMessage: text.default('Your private channel has been created.'),
    movedMessage: text.default('Welcome back to your private channel.'),
    deniedMessage: text.default('You cannot get a private channel here.'),
    passwordMessage: text.default('The password of your channel is: {password}'),
  }),
});

export type PrivateSettings = z.infer<typeof privateSettingsSchema>;

/** The texts a player sees, in one language. */
export type PrivateTexts = Omit<PrivateSettings['english'], 'enabled'>;

export function loadPrivateSettings(db: DbExecutor): PrivateSettings {
  return loadModuleSettings(db, 'private', privateSettingsSchema);
}

const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A password without characters that are easily confused (0/O, 1/l). */
export function generatePassword(length = 8): string {
  let result = '';
  for (let i = 0; i < length; i++)
    result += PASSWORD_CHARS.charAt(randomInt(PASSWORD_CHARS.length));
  return result;
}

/** Channel name for a player; a number is appended when the name is already taken. */
export function privateChannelName(template: string, nickname: string, attempt: number): string {
  const suffix = attempt === 0 ? '' : ` (${String(attempt + 1)})`;
  const base = template.replaceAll('{name}', nickname).trim() || nickname;
  return base.slice(0, CHANNEL_NAME_MAX - suffix.length) + suffix;
}

export interface PrivateDeps extends AutomationDeps {
  /** The server's channel list (one query command). */
  channels: () => Promise<Ts3Channel[]>;
  password?: () => string;
}

/**
 * Private channels (T10.7): whoever enters a lobby gets a channel of their own, is moved into
 * it and receives the configured channel group there. A channel the player still has is reused.
 * The module only records and reuses channels it created itself (rule 13).
 */
export class PrivateModule implements BotModule {
  readonly id = 'private';
  private readonly cooldown = new Cooldown();
  /** One request per player at a time, so a double join cannot create two channels. */
  private readonly busy = new Set<number>();

  constructor(private readonly deps: PrivateDeps) {}

  async onJoin(client: BotClient, info: JoinInfo, at: number): Promise<void> {
    if (!info.discovered) await this.request(client, at);
  }

  onMoved(client: BotClient, _previous: number, _cause: unknown, at: number): Promise<void> {
    return this.request(client, at);
  }

  /** Forgets channels that are gone (temporary ones the server removed, or deleted by hand). */
  async onSynced(): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadPrivateSettings(db);
    const managed = listManaged(db, 'private');
    if (!settings.enabled || managed.length === 0) return;
    const existing = new Set((await this.deps.channels()).map((channel) => channel.cid));
    for (const entry of managed) {
      if (!existing.has(entry.channelId)) removeManaged(db, entry.channelId);
    }
  }

  private async request(client: BotClient, at: number): Promise<void> {
    const settings = loadPrivateSettings(this.deps.database.db);
    if (!settings.enabled) return;
    const lobby = settings.lobbies.find((entry) => entry.lobbyChannelId === client.channelId);
    if (!lobby || isExempt(settings, client.serverGroups) || this.busy.has(client.userId)) return;
    this.busy.add(client.userId);
    try {
      await this.serve(client, lobby, settings, at);
    } finally {
      this.busy.delete(client.userId);
    }
  }

  /** German or English, by the country of the player. */
  private texts(settings: PrivateSettings, client: BotClient): PrivateTexts {
    const language = clientLanguage(this.deps.database, client.userId, settings.english.enabled);
    return language === 'en' ? settings.english : settings;
  }

  private async serve(
    client: BotClient,
    lobby: PrivateLobby,
    settings: PrivateSettings,
    at: number,
  ): Promise<void> {
    const { db } = this.deps.database;
    const actions = new ModuleActions(this.deps, { module: this.id, dryRun: settings.dryRun });
    const texts = this.texts(settings, client);
    const allowed =
      lobby.allowedGroupIds.length === 0 ||
      client.serverGroups.some((group) => lobby.allowedGroupIds.includes(group));
    if (!allowed) {
      await actions.message(client, texts.deniedMessage, 'nicht erlaubte Gruppe');
      await actions.kickFromChannel(client, texts.deniedMessage);
      return;
    }

    const own = listManaged(db, 'private', lobby.id).find(
      (entry) => entry.ownerUserId === client.userId,
    );
    if (own) {
      const moved = await actions.move(client, own.channelId, 'eigener Channel');
      if (moved) {
        await actions.message(client, texts.movedMessage);
        return;
      }
      if (settings.dryRun) return;
      // The channel is gone on the server: forget it and create a new one below.
      removeManaged(db, own.channelId);
    }

    if (!this.cooldown.allow(client.userId, at, settings.cooldownS)) return;
    if (settings.dryRun) {
      actions.note(
        'private.create',
        client,
        privateChannelName(lobby.nameTemplate, client.nickname, 0),
      );
      return;
    }
    await this.create(actions, client, lobby, settings);
  }

  private async create(
    actions: ModuleActions,
    client: BotClient,
    lobby: PrivateLobby,
    settings: PrivateSettings,
  ): Promise<void> {
    const texts = this.texts(settings, client);
    const password = lobby.password ? (this.deps.password ?? generatePassword)() : undefined;
    // A temporary channel pulls its creator in; remember where the bot has to go back to.
    const self = lobby.kind === 'temporary' ? await this.deps.commands.self() : undefined;

    let cid: number | undefined;
    // The name may be taken (two players with the same nickname): try numbered variants.
    for (let attempt = 0; attempt < 3 && cid === undefined; attempt++) {
      const name = privateChannelName(lobby.nameTemplate, client.nickname, attempt);
      await actions.run('private.create', client, name, async (commands) => {
        cid = await commands.channelCreate({
          name,
          parentId: lobby.parentId,
          kind: lobby.kind,
          maxClients: lobby.maxClients,
          codecQuality: lobby.codecQuality,
          ...(lobby.kind === 'temporary' ? { deleteDelayS: lobby.deleteDelayS } : {}),
          ...(lobby.description === ''
            ? {}
            : { description: fillTemplate(lobby.description, { name: client.nickname }) }),
          ...(password === undefined ? {} : { password }),
        });
      });
    }
    if (cid === undefined) return;
    const channelId = cid;
    addManaged(this.deps.database.db, {
      channelId,
      module: 'private',
      scope: lobby.id,
      ownerUserId: client.userId,
      createdAt: this.deps.now(),
    });

    await actions.move(client, channelId, 'neuer Channel');
    const { channelGroupId } = lobby;
    if (channelGroupId !== null) {
      await actions.run('private.group', client, `Channel-Gruppe ${String(channelGroupId)}`, (c) =>
        c.setChannelGroup(client.dbid, channelId, channelGroupId),
      );
    }
    if (self) {
      await actions.run('private.return', undefined, undefined, (c) =>
        c.move(self.clid, self.channelId),
      );
    }
    await actions.message(client, texts.createdMessage);
    if (password !== undefined) {
      // The password itself must not end up in the automation log.
      await actions.message(
        client,
        texts.passwordMessage.replaceAll('{password}', password),
        'Passwort mitgeteilt',
      );
    }
  }
}

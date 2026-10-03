import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import { SlidingCounter, spamStep } from '../../domain/spam.js';
import { MOVE_REASON_SELF, type Ts3ChannelCreated } from '../../ts3/types.js';
import type { MoveCause } from '../../watcher/tracker.js';
import {
  BAN_REASON_MAX,
  KICK_REASON_MAX,
  ModuleActions,
  POKE_MAX,
  type AutomationDeps,
} from '../actions.js';
import type { BotClient, BotModule, JoinInfo } from '../host.js';
import { isExempt, loadModuleSettings, moduleBase } from '../settings.js';
import { loadPrivateSettings } from './private.js';

export const SPAM_CATEGORIES = [
  'channelSwitch',
  'channelCreate',
  'nickname',
  'reconnect',
  'lobby',
] as const;
export type SpamCategory = (typeof SPAM_CATEGORIES)[number];

const threshold = z.number().int().min(0).max(1000);

function category(defaults: {
  windowS: number;
  warnAt: number;
  kickAt: number;
  banAt: number;
  text: string;
}) {
  const shape = {
    enabled: z.boolean().default(false),
    /** Seconds the count looks back. */
    windowS: z.number().int().min(5).max(3600).default(defaults.windowS),
    /** Counts at which each step happens; 0 switches the step off. */
    warnAt: threshold.default(defaults.warnAt),
    kickAt: threshold.default(defaults.kickAt),
    banAt: threshold.default(defaults.banAt),
    banDurationS: z
      .number()
      .int()
      .min(60)
      .max(30 * 86_400)
      .default(600),
    warnBy: z.enum(['poke', 'message']).default('poke'),
    warnMessage: z
      .string()
      .trim()
      .min(1)
      .max(POKE_MAX)
      .default(`Bitte langsamer: ${defaults.text}.`),
    /** Reason shown with kick and ban; a kick only shows 40 characters. */
    reason: z.string().trim().min(1).max(BAN_REASON_MAX).default(`Spam: ${defaults.text}`),
  };
  return z.object(shape).default(z.object(shape).parse({}));
}

export const spamSettingsSchema = moduleBase.extend({
  /** Switching channels by oneself; being moved does not count. */
  channelSwitch: category({
    windowS: 10,
    warnAt: 6,
    kickAt: 10,
    banAt: 0,
    text: 'Channel-Wechsel',
  }),
  channelCreate: category({
    windowS: 60,
    warnAt: 3,
    kickAt: 5,
    banAt: 0,
    text: 'Channels anlegen',
  }),
  /** Renames are only seen by the poll, so at most one per poll interval can be counted. */
  nickname: category({ windowS: 600, warnAt: 3, kickAt: 5, banAt: 0, text: 'Nickname ändern' }),
  /** A warning cannot reach someone who keeps reconnecting, so only the ban is on by default. */
  reconnect: category({ windowS: 300, warnAt: 0, kickAt: 0, banAt: 8, text: 'Neuverbinden' }),
  /** Entering a lobby of the private channels. */
  lobby: category({
    windowS: 60,
    warnAt: 3,
    kickAt: 6,
    banAt: 0,
    text: 'Privat-Channel anfordern',
  }),
});

export type SpamSettings = z.infer<typeof spamSettingsSchema>;
export type SpamCategorySettings = SpamSettings[SpamCategory];

export function loadSpamSettings(db: DbExecutor): SpamSettings {
  return loadModuleSettings(db, 'spam', spamSettingsSchema);
}

const LABELS: Record<SpamCategory, string> = {
  channelSwitch: 'Channel-Wechsel',
  channelCreate: 'Channels angelegt',
  nickname: 'Nickname-Änderungen',
  reconnect: 'Verbindungen',
  lobby: 'Lobby-Besuche',
};

/**
 * Spam control (T10.9): counts what a player repeats – separately per kind of action, each
 * with its own window and thresholds – and warns, kicks or bans for a limited time. Counts are
 * kept per player (not per connection), so reconnecting does not reset them.
 */
export class SpamModule implements BotModule {
  readonly id = 'spam';
  private readonly counter = new SlidingCounter();

  constructor(private readonly deps: AutomationDeps) {}

  async onJoin(client: BotClient, info: JoinInfo, at: number): Promise<void> {
    if (!info.discovered) await this.count('reconnect', client, at);
  }

  onNickname(client: BotClient, _previous: string, at: number): Promise<void> {
    return this.count('nickname', client, at);
  }

  async onMoved(
    client: BotClient,
    _previous: number,
    cause: MoveCause | undefined,
    at: number,
  ): Promise<void> {
    // Moves noticed by the poll have no cause; only what the player did counts.
    if (cause?.reasonId !== MOVE_REASON_SELF) return;
    const lobbies = loadPrivateSettings(this.deps.database.db).lobbies;
    if (lobbies.some((lobby) => lobby.lobbyChannelId === client.channelId)) {
      await this.count('lobby', client, at);
    }
    await this.count('channelSwitch', client, at);
  }

  onChannelCreated(client: BotClient, _event: Ts3ChannelCreated, at: number): Promise<void> {
    return this.count('channelCreate', client, at);
  }

  private async count(kind: SpamCategory, client: BotClient, at: number): Promise<void> {
    const settings = loadSpamSettings(this.deps.database.db);
    const rules = settings[kind];
    if (!settings.enabled || !rules.enabled || isExempt(settings, client.serverGroups)) return;
    const key = `${kind}:${String(client.userId)}`;
    const count = this.counter.hit(key, at, rules.windowS);
    const step = spamStep(count, rules);
    if (!step) return;

    const actions = new ModuleActions(this.deps, { module: this.id, dryRun: settings.dryRun });
    const detail = `${LABELS[kind]}: ${String(count)} in ${String(rules.windowS)} s`;
    if (step === 'warn') {
      if (rules.warnBy === 'poke') await actions.poke(client, rules.warnMessage, detail);
      else await actions.message(client, rules.warnMessage, detail);
      return;
    }
    if (step === 'kick') {
      await actions.kick(client, rules.reason.slice(0, KICK_REASON_MAX), detail);
      return;
    }
    await actions.ban(client, rules.banDurationS, rules.reason, detail);
    // A fresh start after the ban; in test mode this also keeps the log from filling up.
    this.counter.reset(key);
  }
}

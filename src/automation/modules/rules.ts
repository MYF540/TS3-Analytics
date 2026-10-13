import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import { ruleAcceptances, type RuleDecision } from '../../db/schema.js';
import { Cooldown } from '../../domain/support.js';
import { KICK_REASON_MAX, MESSAGE_MAX, ModuleActions, type AutomationDeps } from '../actions.js';
import type { BotClient, BotModule, JoinInfo } from '../host.js';
import { isExempt, loadModuleSettings, moduleBase } from '../settings.js';

const text = z.string().trim().min(1).max(MESSAGE_MAX);
const command = z.string().trim().min(1).max(40);
const channel = z.number().int().positive().nullable().default(null);

/** Countries whose players get the German texts; everybody else gets the English ones. */
export const GERMAN_SPEAKING = ['DE', 'AT', 'CH', 'LI'] as const;

export type RuleLanguage = 'de' | 'en';

/**
 * Language of the rule texts for a player. German is the server's own language, so it is also
 * what a player with an unknown country gets.
 */
export function ruleLanguage(
  country: string | null | undefined,
  englishEnabled: boolean,
): RuleLanguage {
  if (!englishEnabled || !country) return 'de';
  return (GERMAN_SPEAKING as readonly string[]).includes(country.toUpperCase()) ? 'de' : 'en';
}

const englishDefaults = {
  enabled: false,
  rules: [] as string[],
  acceptCommand: 'accept',
  declineCommand: 'decline',
  prompt: 'Reply with "{accept}" to confirm the rules, or with "{decline}" to decline them.',
  acceptedMessage: 'Thank you, you have confirmed the rules.',
  declinedMessage: 'You have declined the rules.',
  kickReason: 'Rules not confirmed',
};

/** The English counterpart of the texts, for players from outside the German-speaking countries. */
const englishTexts = z
  .object({
    enabled: z.boolean().default(englishDefaults.enabled),
    rules: z.array(text).max(30).default(englishDefaults.rules),
    acceptCommand: command.default(englishDefaults.acceptCommand),
    declineCommand: command.default(englishDefaults.declineCommand),
    prompt: text.default(englishDefaults.prompt),
    acceptedMessage: text.default(englishDefaults.acceptedMessage),
    declinedMessage: text.default(englishDefaults.declinedMessage),
    kickReason: z.string().trim().min(1).max(KICK_REASON_MAX).default(englishDefaults.kickReason),
  })
  .default(englishDefaults);

export const rulesSettingsSchema = moduleBase.extend({
  /** Raised when the rules changed in a way everybody has to confirm again. */
  version: z.number().int().min(1).max(100_000).default(1),
  /** The rules; every entry is sent as one private message. */
  rules: z.array(text).max(30).default([]),
  /** Send the rules to everyone who connects, or only to who enters the rule channel. */
  trigger: z.enum(['join', 'channel']).default('join'),
  ruleChannelId: channel,
  /** Confirmation by a private message to the bot. */
  viaChat: z.boolean().default(true),
  acceptCommand: command.default('akzeptieren'),
  declineCommand: command.default('ablehnen'),
  /** Confirmation by entering a channel. */
  viaChannel: z.boolean().default(false),
  acceptChannelId: channel,
  /** Where a player is moved after confirming by channel; null = back where they came from. */
  returnChannelId: channel,
  /** Sent after the rules; `{accept}` and `{decline}` are the two commands. */
  prompt: text.default(
    'Antworte mir mit „{accept}“, um die Regeln zu bestätigen, oder mit „{decline}“, um sie abzulehnen.',
  ),
  acceptedMessage: text.default('Danke, du hast die Regeln bestätigt.'),
  declinedMessage: text.default('Du hast die Regeln abgelehnt.'),
  /** Server group for everyone who confirmed the current version; null = none. */
  acceptedGroupId: z.number().int().positive().nullable().default(null),
  /** Kick players who decline. */
  kickOnDecline: z.boolean().default(false),
  /** Seconds to decide before a kick; 0 = no deadline. Checked with every poll. */
  deadlineS: z.number().int().min(0).max(86_400).default(0),
  kickReason: z.string().trim().min(1).max(KICK_REASON_MAX).default('Regeln nicht bestätigt'),
  /** English texts; the version, the channels, the group and the deadline are shared. */
  english: englishTexts,
});

export type RulesSettings = z.infer<typeof rulesSettingsSchema>;

/** The texts a player sees, in one language. */
export interface RuleTexts {
  rules: readonly string[];
  acceptCommand: string;
  declineCommand: string;
  prompt: string;
  acceptedMessage: string;
  declinedMessage: string;
  kickReason: string;
}

export function ruleTexts(settings: RulesSettings, language: RuleLanguage): RuleTexts {
  return language === 'en' ? settings.english : settings;
}

export function loadRulesSettings(db: DbExecutor): RulesSettings {
  return loadModuleSettings(db, 'rules', rulesSettingsSchema);
}

export interface RuleState {
  version: number;
  decision: RuleDecision;
  at: number;
}

export function getRuleState(db: DbExecutor, userId: number): RuleState | undefined {
  return db
    .select({
      version: ruleAcceptances.version,
      decision: ruleAcceptances.decision,
      at: ruleAcceptances.at,
    })
    .from(ruleAcceptances)
    .where(eq(ruleAcceptances.userId, userId))
    .get();
}

function setRuleState(db: DbExecutor, userId: number, state: RuleState): void {
  db.insert(ruleAcceptances)
    .values({ userId, ...state })
    .onConflictDoUpdate({ target: ruleAcceptances.userId, set: state })
    .run();
}

/** True when the player confirmed the version of the rules that is in force. */
export function hasAccepted(state: RuleState | undefined, version: number): boolean {
  return state?.decision === 'accepted' && state.version >= version;
}

/** Seconds before the rules are sent to the same player again. */
const RESEND_COOLDOWN_S = 60;

/**
 * Rule confirmation (T10.8): sends the rules as private messages and takes the answer either
 * as a chat command or by the player entering a confirmation channel. Who confirmed the current
 * version can get a server group; who declines or lets the deadline pass can be kicked.
 */
export class RulesModule implements BotModule {
  readonly id = 'rules';
  private readonly resend = new Cooldown();
  /** Players who were asked and have not decided: connection id → when they were asked. */
  private readonly asked = new Map<number, { client: BotClient; at: number }>();
  /** Where a player was before entering the confirmation channel. */
  private readonly cameFrom = new Map<number, number>();

  constructor(private readonly deps: AutomationDeps) {}

  private actions(settings: RulesSettings): ModuleActions {
    return new ModuleActions(this.deps, {
      module: this.id,
      dryRun: settings.dryRun,
      ownGroupIds: settings.acceptedGroupId === null ? [] : [settings.acceptedGroupId],
    });
  }

  /** German or English, by the country the player connects from (or was last seen in). */
  private texts(settings: RulesSettings, client: BotClient): RuleTexts {
    const row = this.deps.database.sqlite
      .prepare('SELECT country FROM users WHERE id = ?')
      .get(client.userId) as { country: string | null } | undefined;
    return ruleTexts(settings, ruleLanguage(row?.country, settings.english.enabled));
  }

  private applies(settings: RulesSettings, client: BotClient): boolean {
    return (
      settings.enabled && settings.rules.length > 0 && !isExempt(settings, client.serverGroups)
    );
  }

  async onJoin(client: BotClient, info: JoinInfo, at: number): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadRulesSettings(db);
    if (!this.applies(settings, client)) return;
    if (hasAccepted(getRuleState(db, client.userId), settings.version)) {
      await this.ensureGroup(settings, client);
      return;
    }
    // After a restart everybody online would be asked at once; they are asked on their next join.
    if (info.discovered) return;
    if (settings.trigger === 'join' || client.channelId === settings.ruleChannelId) {
      await this.ask(settings, client, at);
    }
  }

  async onMoved(client: BotClient, previous: number, _cause: unknown, at: number): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadRulesSettings(db);
    if (!this.applies(settings, client)) return;
    const accepted = hasAccepted(getRuleState(db, client.userId), settings.version);
    if (settings.viaChannel && client.channelId === settings.acceptChannelId) {
      this.cameFrom.set(client.clid, previous);
      if (!accepted) await this.decide(settings, client, 'accepted', at);
      await this.sendBack(settings, client);
      return;
    }
    if (
      !accepted &&
      settings.trigger === 'channel' &&
      client.channelId === settings.ruleChannelId
    ) {
      await this.ask(settings, client, at);
    }
  }

  async onMessage(client: BotClient, message: string, at: number): Promise<void> {
    const settings = loadRulesSettings(this.deps.database.db);
    if (!this.applies(settings, client) || !settings.viaChat || settings.dryRun) return;
    const said = message.trim().toLowerCase();
    // Either language's word counts, whatever language the rules were sent in.
    const words = (pick: (texts: RuleTexts) => string) =>
      [settings, ...(settings.english.enabled ? [settings.english] : [])].map((texts) =>
        pick(texts).toLowerCase(),
      );
    if (words((texts) => texts.acceptCommand).includes(said)) {
      await this.decide(settings, client, 'accepted', at);
    } else if (words((texts) => texts.declineCommand).includes(said)) {
      await this.decide(settings, client, 'declined', at);
    }
  }

  onLeft(client: BotClient): void {
    this.asked.delete(client.clid);
    this.cameFrom.delete(client.clid);
  }

  /** Deadlines are checked with the poll, so a kick can be up to one poll interval late. */
  async onSynced(): Promise<void> {
    const settings = loadRulesSettings(this.deps.database.db);
    if (!settings.enabled || settings.deadlineS === 0) return;
    const now = this.deps.now();
    for (const [clid, { client, at }] of this.asked) {
      if (now - at < settings.deadlineS) continue;
      this.asked.delete(clid);
      await this.actions(settings).kick(
        client,
        this.texts(settings, client).kickReason,
        'Frist abgelaufen',
      );
    }
  }

  private async ask(settings: RulesSettings, client: BotClient, at: number): Promise<void> {
    if (!this.resend.allow(client.userId, at, RESEND_COOLDOWN_S)) return;
    const actions = this.actions(settings);
    if (settings.dryRun) {
      actions.note('rules.send', client, `Version ${String(settings.version)}`);
      return;
    }
    const texts = this.texts(settings, client);
    for (const [index, rule] of texts.rules.entries()) {
      await actions.message(client, rule, `Regel ${String(index + 1)}`);
    }
    if (settings.viaChat) {
      const prompt = texts.prompt
        .replaceAll('{accept}', texts.acceptCommand)
        .replaceAll('{decline}', texts.declineCommand);
      await actions.message(client, prompt, 'Aufforderung');
    }
    this.asked.set(client.clid, { client, at });
  }

  private async decide(
    settings: RulesSettings,
    client: BotClient,
    decision: RuleDecision,
    at: number,
  ): Promise<void> {
    const { db } = this.deps.database;
    const actions = this.actions(settings);
    if (settings.dryRun) {
      actions.note(`rules.${decision}`, client, `Version ${String(settings.version)}`);
      return;
    }
    const before = getRuleState(db, client.userId);
    const same = before?.decision === decision && before.version >= settings.version;
    setRuleState(db, client.userId, { version: settings.version, decision, at });
    this.asked.delete(client.clid);
    if (!same) actions.note(`rules.${decision}`, client, `Version ${String(settings.version)}`);

    if (decision === 'accepted') {
      await actions.message(client, this.texts(settings, client).acceptedMessage);
      await this.ensureGroup(settings, client);
      return;
    }
    const group = settings.acceptedGroupId;
    if (group !== null && client.serverGroups.includes(group)) {
      await actions.removeGroup(client, group);
    }
    const texts = this.texts(settings, client);
    await actions.message(client, texts.declinedMessage);
    if (settings.kickOnDecline) await actions.kick(client, texts.kickReason, 'abgelehnt');
  }

  /** Gives the group to someone who confirmed but does not have it (yet, or any more). */
  private async ensureGroup(settings: RulesSettings, client: BotClient): Promise<void> {
    const group = settings.acceptedGroupId;
    if (group === null || client.serverGroups.includes(group)) return;
    const added = await this.actions(settings).addGroup(client, group);
    if (added) client.serverGroups = [...client.serverGroups, group];
  }

  private async sendBack(settings: RulesSettings, client: BotClient): Promise<void> {
    const target = settings.returnChannelId ?? this.cameFrom.get(client.clid);
    this.cameFrom.delete(client.clid);
    if (target === undefined || target === client.channelId) return;
    await this.actions(settings).move(client, target, 'nach Bestätigung');
  }
}

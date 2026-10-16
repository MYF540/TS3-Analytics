import { z } from 'zod';
import type { DbExecutor } from '../../db/repositories/index.js';
import { findForbidden, PATTERN_MAX_LENGTH } from '../../domain/nickname-check.js';
import { ModuleActions, POKE_MAX, type AutomationDeps } from '../actions.js';
import type { BotClient, BotModule } from '../host.js';
import { clientLanguage, englishSection } from '../language.js';
import { isExempt, loadModuleSettings, moduleBase } from '../settings.js';

export const NICKNAME_ACTIONS = ['message', 'poke', 'kick'] as const;

export const nicknamePattern = z.object({
  pattern: z.string().min(1).max(PATTERN_MAX_LENGTH),
  /** Regular expression instead of plain text. */
  regex: z.boolean().default(false),
  /** Own text for this pattern; the general one is used when missing. */
  message: z.string().trim().max(POKE_MAX).optional(),
  /** Its English counterpart, for players outside the German-speaking countries (T12.1). */
  messageEnglish: z.string().trim().max(POKE_MAX).optional(),
});

export const nicknameSettingsSchema = moduleBase.extend({
  patterns: z.array(nicknamePattern).max(100).default([]),
  /** Also compare a simplified form of the nickname ("Ａdm1n" reads as "admin"). */
  lookalikes: z.boolean().default(true),
  action: z.enum(NICKNAME_ACTIONS).default('kick'),
  /** Text for the player. A kick only shows its first 40 characters. */
  message: z
    .string()
    .trim()
    .min(1)
    .max(POKE_MAX)
    .default('Dieser Nickname ist hier nicht erlaubt.'),
  /** English text for players outside the German-speaking countries (T12.1). */
  english: englishSection({
    message: z.string().trim().min(1).max(POKE_MAX).default('This nickname is not allowed here.'),
  }),
});

export type NicknameSettings = z.infer<typeof nicknameSettingsSchema>;

export function loadNicknameSettings(db: DbExecutor): NicknameSettings {
  return loadModuleSettings(db, 'nickname', nicknameSettingsSchema);
}

/**
 * Nickname checker (T10.3): compares the nickname of everyone who joins or renames against the
 * list of forbidden patterns and messages, pokes or kicks. Renames are only seen by the poll,
 * so a forbidden name can stay for up to one poll interval.
 */
export class NicknameModule implements BotModule {
  readonly id = 'nickname';

  constructor(private readonly deps: AutomationDeps) {}

  onJoin(client: BotClient): Promise<void> {
    return this.check(client);
  }

  onNickname(client: BotClient): Promise<void> {
    return this.check(client);
  }

  private async check(client: BotClient): Promise<void> {
    const settings = loadNicknameSettings(this.deps.database.db);
    if (!settings.enabled || isExempt(settings, client.serverGroups)) return;
    const hit = findForbidden(client.nickname, settings.patterns, settings.lookalikes);
    if (!hit) return;

    const actions = new ModuleActions(this.deps, { module: this.id, dryRun: settings.dryRun });
    const english =
      clientLanguage(this.deps.database, client.userId, settings.english.enabled) === 'en';
    const text = english
      ? hit.messageEnglish || settings.english.message
      : hit.message || settings.message;
    const detail = `Nickname „${client.nickname}“, Muster „${hit.pattern}“`;
    if (settings.action === 'kick') await actions.kick(client, text, detail);
    else if (settings.action === 'poke') await actions.poke(client, text, detail);
    else await actions.message(client, text, detail);
  }
}

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { rankGroupIds } from '../../automation/actions.js';
import {
  getRuleState,
  loadRulesSettings,
  rulesSettingsSchema,
} from '../../automation/modules/rules.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { getUserById, listChannels } from '../../db/repositories/index.js';
import { RULE_DECISIONS } from '../../db/schema.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const named = z.array(z.object({ id: z.number().int(), name: z.string() }));

export const rulesSettingsResponse = z.object({
  settings: z.object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    exemptGroupIds: z.array(z.number().int()),
    version: z.number().int(),
    rules: z.array(z.string()),
    trigger: z.enum(['join', 'channel']),
    ruleChannelId: z.number().int().nullable(),
    viaChat: z.boolean(),
    acceptCommand: z.string(),
    declineCommand: z.string(),
    viaChannel: z.boolean(),
    acceptChannelId: z.number().int().nullable(),
    returnChannelId: z.number().int().nullable(),
    prompt: z.string(),
    acceptedMessage: z.string(),
    declinedMessage: z.string(),
    acceptedGroupId: z.number().int().nullable(),
    kickOnDecline: z.boolean(),
    deadlineS: z.number().int(),
    kickReason: z.string(),
    english: z.object({
      enabled: z.boolean(),
      rules: z.array(z.string()),
      acceptCommand: z.string(),
      declineCommand: z.string(),
      prompt: z.string(),
      acceptedMessage: z.string(),
      declinedMessage: z.string(),
      kickReason: z.string(),
    }),
  }),
  groups: named,
  channels: named,
  /** Decisions about the version of the rules that is in force. */
  stats: z.object({ accepted: z.number().int(), declined: z.number().int() }),
});

export const playerRulesResponse = z.object({
  /** Whether the rule confirmation is switched on at all. */
  enabled: z.boolean(),
  currentVersion: z.number().int(),
  state: z
    .object({
      version: z.number().int(),
      decision: z.enum(RULE_DECISIONS),
      at: z.number().int(),
    })
    .nullable(),
});

/** What keeps the settings from working, as an error code; undefined when they are fine. */
function problem(
  settings: z.infer<typeof rulesSettingsSchema>,
  rankGroups: ReadonlySet<number>,
): string | undefined {
  if (settings.acceptedGroupId !== null && rankGroups.has(settings.acceptedGroupId)) {
    return 'RULES_RANK_GROUP';
  }
  // A word that confirms in one language must not decline in the other.
  const { english } = settings;
  const accept = [settings.acceptCommand, ...(english.enabled ? [english.acceptCommand] : [])];
  const decline = [settings.declineCommand, ...(english.enabled ? [english.declineCommand] : [])];
  const lower = (words: string[]) => words.map((word) => word.toLowerCase());
  if (lower(accept).some((word) => lower(decline).includes(word))) return 'RULES_SAME_COMMAND';
  if (!settings.enabled) return undefined;
  if (english.enabled && english.rules.length === 0) return 'RULES_INCOMPLETE';
  const incomplete =
    settings.rules.length === 0 ||
    (!settings.viaChat && !settings.viaChannel) ||
    (settings.viaChannel && settings.acceptChannelId === null) ||
    (settings.trigger === 'channel' && settings.ruleChannelId === null);
  return incomplete ? 'RULES_INCOMPLETE' : undefined;
}

/** Settings of the rule confirmation (T10.8) and a player's decision. */
export function automationRulesRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db, sqlite } = context.database;
    const response = () => {
      const settings = loadRulesSettings(db);
      const rows = sqlite
        .prepare(
          `SELECT decision, count(*) AS n FROM rule_acceptances WHERE version >= ?
           GROUP BY decision`,
        )
        .all(settings.version) as { decision: string; n: number }[];
      const count = (decision: string) => rows.find((row) => row.decision === decision)?.n ?? 0;
      return {
        settings,
        groups: loadGroupWatch(db).knownGroups,
        channels: listChannels(db).map(({ id, name }) => ({ id, name })),
        stats: { accepted: count('accepted'), declined: count('declined') },
      };
    };

    app.get(
      '/automation/rules',
      { config: { auth: 'admin' }, schema: { response: { 200: rulesSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/rules',
      {
        config: { auth: 'admin' },
        schema: { body: rulesSettingsSchema, response: { 200: rulesSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        const code = problem(settings, rankGroupIds(context.database));
        if (code) throw new ApiError(400, code, 'The rule settings cannot be used');
        request.audit({
          action: 'automation.rules',
          targetType: 'settings',
          targetId: 'automation.rules',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            version: settings.version,
            rules: settings.rules.length,
            acceptedGroupId: settings.acceptedGroupId,
            kickOnDecline: settings.kickOnDecline,
            deadlineS: settings.deadlineS,
          },
        });
        saveModuleSettings(db, 'rules', settings, context.now());
        return response();
      },
    );

    app.get(
      '/users/:id/rules',
      {
        config: { auth: 'moderator' },
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: { 200: playerRulesResponse },
        },
      },
      (request) => {
        if (!getUserById(db, request.params.id)) {
          throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        }
        const settings = loadRulesSettings(db);
        return {
          enabled: settings.enabled,
          currentVersion: settings.version,
          state: getRuleState(db, request.params.id) ?? null,
        };
      },
    );

    return Promise.resolve();
  };
}

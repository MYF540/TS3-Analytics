import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  loadSpamSettings,
  SPAM_CATEGORIES,
  spamSettingsSchema,
} from '../../automation/modules/spam.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { thresholdsAscend } from '../../domain/spam.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const categoryOutput = z.object({
  enabled: z.boolean(),
  windowS: z.number().int(),
  warnAt: z.number().int(),
  kickAt: z.number().int(),
  banAt: z.number().int(),
  banDurationS: z.number().int(),
  warnBy: z.enum(['poke', 'message']),
  warnMessage: z.string(),
  reason: z.string(),
});

const englishCategoryOutput = z.object({ warnMessage: z.string(), reason: z.string() });

export const spamSettingsResponse = z.object({
  settings: z.object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    exemptGroupIds: z.array(z.number().int()),
    channelSwitch: categoryOutput,
    channelCreate: categoryOutput,
    nickname: categoryOutput,
    reconnect: categoryOutput,
    lobby: categoryOutput,
    english: z.object({
      enabled: z.boolean(),
      channelSwitch: englishCategoryOutput,
      channelCreate: englishCategoryOutput,
      nickname: englishCategoryOutput,
      reconnect: englishCategoryOutput,
      lobby: englishCategoryOutput,
    }),
  }),
  groups: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

/** Settings of the spam control (T10.9) – admins only. */
export function automationSpamRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = () => ({
      settings: loadSpamSettings(db),
      groups: loadGroupWatch(db).knownGroups,
    });

    app.get(
      '/automation/spam',
      { config: { auth: 'admin' }, schema: { response: { 200: spamSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/spam',
      {
        config: { auth: 'admin' },
        schema: { body: spamSettingsSchema, response: { 200: spamSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        // A kind that is on needs at least one step, and the steps have to rise.
        const broken = SPAM_CATEGORIES.filter((kind) => {
          const rules = settings[kind];
          const steps = rules.warnAt + rules.kickAt + rules.banAt;
          return !thresholdsAscend(rules) || (rules.enabled && steps === 0);
        });
        if (broken.length > 0) {
          throw new ApiError(400, 'SPAM_INVALID_THRESHOLDS', 'Thresholds cannot be used', broken);
        }
        request.audit({
          action: 'automation.spam',
          targetType: 'settings',
          targetId: 'automation.spam',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            kinds: SPAM_CATEGORIES.filter((kind) => settings[kind].enabled),
          },
        });
        saveModuleSettings(db, 'spam', settings, context.now());
        return response();
      },
    );

    return Promise.resolve();
  };
}

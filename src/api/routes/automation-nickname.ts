import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  loadNicknameSettings,
  nicknamePattern,
  nicknameSettingsSchema,
} from '../../automation/modules/nickname.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { findForbidden, patternProblem } from '../../domain/nickname-check.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const settingsOutput = z.object({
  enabled: z.boolean(),
  dryRun: z.boolean(),
  exemptGroupIds: z.array(z.number().int()),
  patterns: z.array(
    z.object({ pattern: z.string(), regex: z.boolean(), message: z.string().optional() }),
  ),
  lookalikes: z.boolean(),
  action: z.enum(['message', 'poke', 'kick']),
  message: z.string(),
});

export const nicknameSettingsResponse = z.object({
  settings: settingsOutput,
  /** Server groups seen on the server, for the list of exempt groups. */
  groups: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

export const nicknameTestResponse = z.object({
  /** Position of the pattern that matched, or null when the nickname is fine. */
  match: z.number().int().nullable(),
});

/** Settings of the nickname checker (T10.3) and a try-out for patterns – admins only. */
export function automationNicknameRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = () => ({
      settings: loadNicknameSettings(db),
      groups: loadGroupWatch(db).knownGroups,
    });

    app.get(
      '/automation/nickname',
      { config: { auth: 'admin' }, schema: { response: { 200: nicknameSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/nickname',
      {
        config: { auth: 'admin' },
        schema: { body: nicknameSettingsSchema, response: { 200: nicknameSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        const broken = settings.patterns.flatMap((pattern, index) => {
          const problem = patternProblem(pattern);
          return problem === undefined ? [] : [{ index, problem }];
        });
        if (broken.length > 0) {
          throw new ApiError(400, 'INVALID_PATTERN', 'A pattern cannot be used', broken);
        }
        request.audit({
          action: 'automation.nickname',
          targetType: 'settings',
          targetId: 'automation.nickname',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            action: settings.action,
            patterns: settings.patterns.length,
          },
        });
        saveModuleSettings(db, 'nickname', settings, context.now());
        return response();
      },
    );

    // Works on the patterns of the form, saved or not.
    app.post(
      '/automation/nickname/test',
      {
        config: { auth: 'admin' },
        schema: {
          body: z.object({
            nickname: z.string().min(1).max(100),
            patterns: z.array(nicknamePattern).max(100),
            lookalikes: z.boolean(),
          }),
          response: { 200: nicknameTestResponse },
        },
      },
      (request) => {
        const { nickname, patterns, lookalikes } = request.body;
        const hit = findForbidden(nickname, patterns, lookalikes);
        return { match: hit ? patterns.indexOf(hit) : null };
      },
    );

    return Promise.resolve();
  };
}

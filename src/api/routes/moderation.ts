import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getUserById } from '../../db/repositories/index.js';
import {
  moderationAction,
  ModerationError,
  resolveBan,
  runModerationAction,
  type ModerationAction,
} from '../../moderation/actions.js';
import {
  banTemplateSchema,
  loadModerationSettings,
  saveModerationSettings,
} from '../../moderation/settings.js';
import { NotConnectedError } from '../../ts3/connection.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

export const moderationSettingsResponse = z.object({
  enabled: z.boolean(),
  banTemplates: z.array(banTemplateSchema),
});

const ERRORS: Record<ModerationError['code'], [number, string]> = {
  MODERATION_DISABLED: [409, 'Moderation actions are switched off'],
  NOT_ONLINE: [409, 'The player is not online'],
  UNKNOWN_TEMPLATE: [400, 'Unknown ban template'],
  BAN_REASON_MISSING: [400, 'A ban needs a reason'],
};

/** What the audit log keeps about an action (message texts shortened). */
function auditDetails(
  action: ModerationAction,
  settings: ReturnType<typeof loadModerationSettings>,
) {
  switch (action.type) {
    case 'poke':
    case 'message':
      return { message: action.message.slice(0, 200) };
    case 'kick':
      return { from: action.from, reason: action.reason };
    case 'move':
      return { channelId: action.channelId };
    case 'ban': {
      let resolved: { reason: string; durationS: number } | undefined;
      try {
        resolved = resolveBan(action, settings);
      } catch {
        resolved = undefined;
      }
      return { templateId: action.templateId ?? null, includeIp: action.includeIp, ...resolved };
    }
  }
}

/**
 * Moderation (T5.6): admins only, and only while the global switch is on. Every action goes
 * through the rate-limited query queue and is audited – also when it fails.
 */
export function moderationRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;

    app.get(
      '/settings/moderation',
      { config: { auth: 'admin' }, schema: { response: { 200: moderationSettingsResponse } } },
      () => loadModerationSettings(db),
    );

    app.put(
      '/settings/moderation',
      {
        config: { auth: 'admin' },
        schema: {
          body: z.object({
            enabled: z.boolean(),
            banTemplates: z.array(banTemplateSchema).max(20),
          }),
          response: { 200: moderationSettingsResponse },
        },
      },
      (request) => {
        const before = loadModerationSettings(db);
        const ids = request.body.banTemplates.map((t) => t.id);
        request.audit({
          action: 'settings.moderation',
          targetType: 'settings',
          targetId: 'moderation',
          details: {
            enabled: request.body.enabled,
            ...(before.enabled === request.body.enabled ? {} : { wasEnabled: before.enabled }),
            banTemplates: ids,
          },
        });
        if (new Set(ids).size !== ids.length) {
          throw new ApiError(400, 'DUPLICATE_TEMPLATE', 'Template ids must be unique');
        }
        saveModerationSettings(db, request.body, context.now());
        return loadModerationSettings(db);
      },
    );

    app.post(
      '/users/:id/moderation',
      {
        config: { auth: 'admin' },
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: moderationAction,
          response: { 200: z.object({ affected: z.number().int() }) },
        },
      },
      async (request) => {
        const { id } = request.params;
        const action = request.body;
        const settings = loadModerationSettings(db);
        request.audit({
          action: `moderation.${action.type}`,
          targetType: 'user',
          targetId: id,
          details: auditDetails(action, settings),
        });
        const user = getUserById(db, id);
        if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        if (!settings.enabled) {
          throw new ApiError(409, 'MODERATION_DISABLED', ERRORS.MODERATION_DISABLED[1]);
        }
        const commands = context.moderation;
        if (!commands) throw new ApiError(503, 'TS3_UNAVAILABLE', 'Not connected to TeamSpeak');
        try {
          const affected = await runModerationAction(
            commands,
            settings,
            { uid: user.uid, clids: context.live?.clidsOf?.(id) ?? [] },
            action,
          );
          return { affected };
        } catch (error) {
          if (error instanceof ModerationError) {
            const [status, message] = ERRORS[error.code];
            throw new ApiError(status, error.code, message);
          }
          if (error instanceof NotConnectedError) {
            throw new ApiError(503, 'TS3_UNAVAILABLE', 'Not connected to TeamSpeak');
          }
          request.log.warn({ err: error, action: action.type }, 'Moderation action failed');
          throw new ApiError(502, 'TS3_ERROR', 'The TeamSpeak server rejected the command');
        }
      },
    );
    return Promise.resolve();
  };
}

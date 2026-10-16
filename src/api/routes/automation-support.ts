import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadSupportSettings, supportSettingsSchema } from '../../automation/modules/support.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { listChannels } from '../../db/repositories/index.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const settingsOutput = z.object({
  enabled: z.boolean(),
  dryRun: z.boolean(),
  exemptGroupIds: z.array(z.number().int()),
  channelId: z.number().int().nullable(),
  supporterGroupIds: z.array(z.number().int()),
  notify: z.enum(['poke', 'message']),
  supporterMessage: z.string(),
  userMessage: z.string(),
  nobodyMessage: z.string(),
  cooldownS: z.number().int(),
  autoOpen: z.object({
    enabled: z.boolean(),
    openName: z.string(),
    closedName: z.string(),
    openMaxClients: z.number().int(),
    closedMaxClients: z.number().int(),
  }),
  english: z.object({ enabled: z.boolean(), userMessage: z.string(), nobodyMessage: z.string() }),
});

export const supportSettingsResponse = z.object({
  settings: settingsOutput,
  groups: z.array(z.object({ id: z.number().int(), name: z.string() })),
  channels: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

/** Settings of the support channel (T10.4) – admins only. */
export function automationSupportRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = () => ({
      settings: loadSupportSettings(db),
      groups: loadGroupWatch(db).knownGroups,
      channels: listChannels(db).map(({ id, name }) => ({ id, name })),
    });

    app.get(
      '/automation/support',
      { config: { auth: 'admin' }, schema: { response: { 200: supportSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/support',
      {
        config: { auth: 'admin' },
        schema: { body: supportSettingsSchema, response: { 200: supportSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        if (
          settings.enabled &&
          (settings.channelId === null || settings.supporterGroupIds.length === 0)
        ) {
          throw new ApiError(
            400,
            'SUPPORT_INCOMPLETE',
            'An enabled support channel needs a channel and at least one supporter group',
          );
        }
        if (settings.autoOpen.openName === settings.autoOpen.closedName) {
          throw new ApiError(400, 'SUPPORT_SAME_NAME', 'Open and closed name must differ');
        }
        request.audit({
          action: 'automation.support',
          targetType: 'settings',
          targetId: 'automation.support',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            channelId: settings.channelId,
            supporterGroupIds: settings.supporterGroupIds,
            autoOpen: settings.autoOpen.enabled,
          },
        });
        saveModuleSettings(db, 'support', settings, context.now());
        return response();
      },
    );

    return Promise.resolve();
  };
}

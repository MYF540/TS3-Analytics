import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadStaffSettings, staffSettingsSchema } from '../../automation/modules/staff.js';
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
  groups: z.array(z.object({ groupId: z.number().int(), title: z.string() })),
  showInAll: z.boolean(),
  awayInAfkChannel: z.boolean(),
  header: z.string(),
  footer: z.string(),
  groupLine: z.string(),
  memberLine: z.string(),
  online: z.string(),
  away: z.string(),
  offline: z.string(),
  empty: z.string(),
  hideEmptyGroups: z.boolean(),
  clickable: z.boolean(),
});

export const staffSettingsResponse = z.object({
  settings: settingsOutput,
  groups: z.array(z.object({ id: z.number().int(), name: z.string() })),
  channels: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

/** Settings of the staff list (T10.5) – admins only. */
export function automationStaffRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = () => ({
      settings: loadStaffSettings(db),
      groups: loadGroupWatch(db).knownGroups,
      channels: listChannels(db).map(({ id, name }) => ({ id, name })),
    });

    app.get(
      '/automation/staff',
      { config: { auth: 'admin' }, schema: { response: { 200: staffSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/staff',
      {
        config: { auth: 'admin' },
        schema: { body: staffSettingsSchema, response: { 200: staffSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        const ids = settings.groups.map((group) => group.groupId);
        if (new Set(ids).size !== ids.length) {
          throw new ApiError(400, 'STAFF_DUPLICATE_GROUP', 'A group is listed twice');
        }
        if (settings.enabled && (settings.channelId === null || ids.length === 0)) {
          throw new ApiError(
            400,
            'STAFF_INCOMPLETE',
            'An enabled staff list needs a channel and at least one group',
          );
        }
        request.audit({
          action: 'automation.staff',
          targetType: 'settings',
          targetId: 'automation.staff',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            channelId: settings.channelId,
            groupIds: ids,
          },
        });
        saveModuleSettings(db, 'staff', settings, context.now());
        return response();
      },
    );

    return Promise.resolve();
  };
}

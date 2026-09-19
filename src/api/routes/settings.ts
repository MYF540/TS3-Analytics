import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listChannels } from '../../db/repositories/index.js';
import { DEFAULT_ACTIVITY_SETTINGS, type ActivitySettings } from '../../domain/activity.js';
import { loadActivitySettings, saveActivitySettings } from '../../watcher/settings.js';
import type { ApiContext } from '../context.js';

export const activitySettings = z.object({
  idleThresholdS: z.number().int().min(60).max(86_400),
  afkChannelIds: z.array(z.number().int().positive()).max(500),
  awayIsAfk: z.boolean(),
  outputMutedIsAfk: z.boolean(),
});

export const activitySettingsResponse = z.object({
  settings: activitySettings,
  defaults: activitySettings,
  channels: z.array(
    z.object({ id: z.number().int(), name: z.string(), lastSeen: z.number().int() }),
  ),
});

/** Changed fields as `{ field: { from, to } }` for the audit log. */
function diff(before: ActivitySettings, after: ActivitySettings): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof ActivitySettings)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  return changes;
}

/**
 * Activity rules (idle threshold, AFK channels, away/muted = AFK) – admins only. The watcher
 * reads them on every event, so changes apply at once, but only to future time: stored
 * segments are never re-classified.
 */
export function settingsRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;

    app.get(
      '/settings/activity',
      { config: { auth: 'admin' }, schema: { response: { 200: activitySettingsResponse } } },
      () => ({
        settings: loadActivitySettings(db),
        defaults: DEFAULT_ACTIVITY_SETTINGS,
        channels: listChannels(db),
      }),
    );

    app.put(
      '/settings/activity',
      {
        config: { auth: 'admin' },
        schema: { body: activitySettings, response: { 200: activitySettings } },
      },
      (request) => {
        const before = loadActivitySettings(db);
        const after: ActivitySettings = {
          ...request.body,
          afkChannelIds: [...new Set(request.body.afkChannelIds)].sort((a, b) => a - b),
        };
        saveActivitySettings(db, after, context.now());
        request.audit({
          action: 'settings.activity',
          targetType: 'settings',
          targetId: 'activity',
          details: diff(before, after),
        });
        return after;
      },
    );
    return Promise.resolve();
  };
}

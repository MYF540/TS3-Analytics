import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listChannels } from '../../db/repositories/index.js';
import { runNetworkJob } from '../../network/job.js';
import {
  DEFAULT_NETWORK_SETTINGS,
  loadNetworkSettings,
  loadNetworkState,
  saveNetworkSettings,
} from '../../network/settings.js';
import { loadActivitySettings } from '../../watcher/settings.js';
import type { ApiContext } from '../context.js';

const settingsBody = z.object({
  excludedChannelIds: z.array(z.number().int().positive()).max(500),
  candidates: z.number().int().min(10).max(500),
  minEncounterS: z.number().int().min(0).max(86_400),
  minPairS: z.number().int().min(0).max(864_000),
});

const rangeState = z.object({
  nodes: z.number().int(),
  edges: z.number().int(),
  droppedPairs: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
});

export const networkSettingsResponse = z.object({
  settings: settingsBody,
  defaults: settingsBody,
  /** Channels to choose from; the AFK channels are marked, they are always excluded. */
  channels: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      lastSeen: z.number().int(),
      afk: z.boolean(),
    }),
  ),
  /** Result of the last run, `null` while the job has never run. */
  state: z
    .object({
      computedAt: z.number().int(),
      seconds: z.number(),
      ranges: z.record(z.string(), rangeState),
    })
    .nullable(),
});

/**
 * Settings of the player network and the manual run (T9.1), admins only. The network itself is
 * computed by a daily job – the page only reads what it stored.
 */
export function networkRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;

    const response = () => {
      const afk = new Set(loadActivitySettings(db).afkChannelIds);
      return {
        settings: loadNetworkSettings(db),
        defaults: DEFAULT_NETWORK_SETTINGS,
        channels: listChannels(db).map((channel) => ({
          id: channel.id,
          name: channel.name,
          lastSeen: channel.lastSeen,
          afk: afk.has(channel.id),
        })),
        state: loadNetworkState(db) ?? null,
      };
    };

    app.get(
      '/settings/network',
      { config: { auth: 'admin' }, schema: { response: { 200: networkSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/settings/network',
      {
        config: { auth: 'admin' },
        schema: { body: settingsBody, response: { 200: networkSettingsResponse } },
      },
      (request) => {
        const settings = {
          ...request.body,
          excludedChannelIds: [...new Set(request.body.excludedChannelIds)].sort((a, b) => a - b),
        };
        request.audit({
          action: 'settings.network',
          targetType: 'settings',
          targetId: 'network',
          details: settings,
        });
        saveNetworkSettings(db, settings, context.now());
        return response();
      },
    );

    // Needed right after changing the excluded channels – otherwise the page shows the old
    // network until the job runs the next night.
    app.post(
      '/settings/network/run',
      { config: { auth: 'admin' }, schema: { response: { 200: networkSettingsResponse } } },
      (request) => {
        request.audit({ action: 'network.run', targetType: 'settings', targetId: 'network' });
        runNetworkJob(context.database, context.now());
        return response();
      },
    );

    return Promise.resolve();
  };
}

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { networkGraph } from '../../db/queries/network.js';
import { listChannels } from '../../db/repositories/index.js';
import { NETWORK_RANGES } from '../../db/schema.js';
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

export const networkGraphResponse = z.object({
  range: z.enum(NETWORK_RANGES),
  /** When the daily job last ran; null while it never did. */
  computedAt: z.number().int().nullable(),
  from: z.number().int().nullable(),
  to: z.number().int().nullable(),
  nodes: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      seconds: z.number().int(),
      accounts: z.number().int(),
    }),
  ),
  edges: z.array(
    z.object({
      a: z.number().int(),
      b: z.number().int(),
      seconds: z.number().int(),
      encounters: z.number().int(),
      shareA: z.number(),
      shareB: z.number(),
    }),
  ),
  /** Connections stored for this window, even when only some are shown. */
  edgesTotal: z.number().int(),
  strongestS: z.number().int(),
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

    // The graph itself: only reading, the numbers come from the daily job.
    app.get(
      '/network',
      {
        config: { auth: 'admin' },
        schema: {
          querystring: z.object({
            range: z.enum(NETWORK_RANGES).default('30d'),
            /** How many of the strongest connections to draw – the slider on the page. */
            limit: z.coerce.number().int().min(10).max(2000).default(200),
          }),
          response: { 200: networkGraphResponse },
        },
      },
      (request) => {
        const { range, limit } = request.query;
        const state = loadNetworkState(db);
        const window = state?.ranges[range];
        return {
          range,
          computedAt: state?.computedAt ?? null,
          from: window?.from ?? null,
          to: window?.to ?? null,
          ...networkGraph(context.database.sqlite, { range, limit }),
        };
      },
    );

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

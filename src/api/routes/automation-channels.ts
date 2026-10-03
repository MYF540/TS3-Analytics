import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { addManaged, listManaged } from '../../automation/managed-channels.js';
import {
  areaNaming,
  areaProblem,
  channelsSettingsSchema,
  loadChannelsSettings,
  poolChildren,
} from '../../automation/modules/channels.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { listChannels } from '../../db/repositories/index.js';
import { adoptable } from '../../domain/channel-pool.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const areaOutput = z.object({
  id: z.string(),
  parentId: z.number().int(),
  naming: z.enum(['numbered', 'list']),
  prefix: z.string(),
  names: z.array(z.string()),
  minFree: z.number().int(),
  maxChannels: z.number().int(),
  maxClients: z.number().int(),
  codecQuality: z.number().int(),
  joinPower: z.number().int(),
  talkPower: z.number().int(),
  description: z.string(),
});

export const channelsSettingsResponse = z.object({
  settings: z.object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    exemptGroupIds: z.array(z.number().int()),
    areas: z.array(areaOutput),
  }),
  channels: z.array(z.object({ id: z.number().int(), name: z.string() })),
  /** How many channels the module manages in each area. */
  managed: z.array(z.object({ areaId: z.string(), count: z.number().int() })),
});

export const channelsAdoptResponse = z.object({ adopted: z.number().int() });

/** Settings of the channel creator (T10.6) and adopting existing channels – admins only. */
export function automationChannelsRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = () => {
      const settings = loadChannelsSettings(db);
      return {
        settings,
        channels: listChannels(db).map(({ id, name }) => ({ id, name })),
        managed: settings.areas.map((area) => ({
          areaId: area.id,
          count: listManaged(db, 'channels', area.id).length,
        })),
      };
    };

    app.get(
      '/automation/channels',
      { config: { auth: 'admin' }, schema: { response: { 200: channelsSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/channels',
      {
        config: { auth: 'admin' },
        schema: { body: channelsSettingsSchema, response: { 200: channelsSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        const { areas } = settings;
        const broken = areas.flatMap((area, index) => {
          const problem =
            areaProblem(area) ??
            (areas.some((other) => other !== area && other.id === area.id) ? 'id' : undefined) ??
            (areas.some((other) => other !== area && other.parentId === area.parentId)
              ? 'parent'
              : undefined);
          return problem === undefined ? [] : [{ index, problem }];
        });
        if (broken.length > 0) {
          throw new ApiError(400, 'CHANNELS_INVALID_AREA', 'An area cannot be used', broken);
        }
        request.audit({
          action: 'automation.channels',
          targetType: 'settings',
          targetId: 'automation.channels',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            areas: areas.map((area) => ({ id: area.id, parentId: area.parentId })),
          },
        });
        saveModuleSettings(db, 'channels', settings, context.now());
        return response();
      },
    );

    // Hands existing channels that fit the area's naming over to the module (rule 13).
    app.post(
      '/automation/channels/adopt',
      {
        config: { auth: 'admin' },
        schema: {
          body: z.object({ areaId: z.string().max(32) }),
          response: { 200: channelsAdoptResponse },
        },
      },
      async (request) => {
        const area = loadChannelsSettings(db).areas.find((a) => a.id === request.body.areaId);
        if (!area) throw new ApiError(404, 'AREA_NOT_FOUND', 'Unknown area');
        if (!context.channels) throw new ApiError(409, 'BOT_OFFLINE', 'The bot is not connected');
        let channels;
        try {
          channels = await context.channels();
        } catch {
          throw new ApiError(409, 'BOT_OFFLINE', 'The bot is not connected');
        }
        const managed = new Set(listManaged(db, 'channels').map((entry) => entry.channelId));
        const found = adoptable(
          poolChildren(channels, area, managed, (_cid, listed) => listed),
          areaNaming(area),
        );
        const now = context.now();
        context.database.sqlite.transaction(() => {
          for (const channel of found) {
            addManaged(db, {
              channelId: channel.cid,
              module: 'channels',
              scope: area.id,
              createdAt: now,
            });
          }
        })();
        request.audit({
          action: 'automation.channels.adopt',
          targetType: 'settings',
          targetId: 'automation.channels',
          details: { areaId: area.id, channels: found.map((channel) => channel.name) },
        });
        return { adopted: found.length };
      },
    );

    return Promise.resolve();
  };
}

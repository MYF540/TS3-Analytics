import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listManaged } from '../../automation/managed-channels.js';
import { loadPrivateSettings, privateSettingsSchema } from '../../automation/modules/private.js';
import { saveModuleSettings } from '../../automation/settings.js';
import { listChannels } from '../../db/repositories/index.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const lobbyOutput = z.object({
  id: z.string(),
  lobbyChannelId: z.number().int(),
  parentId: z.number().int(),
  nameTemplate: z.string(),
  channelGroupId: z.number().int().nullable(),
  kind: z.enum(['temporary', 'semi', 'permanent']),
  deleteDelayS: z.number().int(),
  description: z.string(),
  maxClients: z.number().int(),
  codecQuality: z.number().int(),
  password: z.boolean(),
  allowedGroupIds: z.array(z.number().int()),
});

const named = z.array(z.object({ id: z.number().int(), name: z.string() }));

export const privateSettingsResponse = z.object({
  settings: z.object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    exemptGroupIds: z.array(z.number().int()),
    lobbies: z.array(lobbyOutput),
    cooldownS: z.number().int(),
    createdMessage: z.string(),
    movedMessage: z.string(),
    deniedMessage: z.string(),
    passwordMessage: z.string(),
    english: z.object({
      enabled: z.boolean(),
      createdMessage: z.string(),
      movedMessage: z.string(),
      deniedMessage: z.string(),
      passwordMessage: z.string(),
    }),
  }),
  groups: named,
  channels: named,
  /** Channel groups of the server; empty while the bot is not connected. */
  channelGroups: named,
  /** Private channels that exist right now, per lobby. */
  managed: z.array(z.object({ lobbyId: z.string(), count: z.number().int() })),
});

/** Settings of the private channels (T10.7) – admins only. */
export function automationPrivateRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = async () => {
      const settings = loadPrivateSettings(db);
      const channelGroups = await (context.channelGroups?.() ?? Promise.resolve([])).catch(
        () => [],
      );
      return {
        settings,
        groups: loadGroupWatch(db).knownGroups,
        channels: listChannels(db).map(({ id, name }) => ({ id, name })),
        // Template and query groups cannot be given to a client.
        channelGroups: channelGroups
          .filter((group) => group.type === 1)
          .map(({ id, name }) => ({ id, name })),
        managed: settings.lobbies.map((lobby) => ({
          lobbyId: lobby.id,
          count: listManaged(db, 'private', lobby.id).length,
        })),
      };
    };

    app.get(
      '/automation/private',
      { config: { auth: 'admin' }, schema: { response: { 200: privateSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/automation/private',
      {
        config: { auth: 'admin' },
        schema: { body: privateSettingsSchema, response: { 200: privateSettingsResponse } },
      },
      (request) => {
        const settings = request.body;
        const { lobbies } = settings;
        const broken = lobbies.flatMap((lobby, index) => {
          const others = lobbies.filter((other) => other !== lobby);
          const problem = others.some((other) => other.id === lobby.id)
            ? 'id'
            : others.some((other) => other.lobbyChannelId === lobby.lobbyChannelId)
              ? 'lobby'
              : lobby.lobbyChannelId === lobby.parentId
                ? 'parent'
                : undefined;
          return problem === undefined ? [] : [{ index, problem }];
        });
        if (broken.length > 0) {
          throw new ApiError(400, 'PRIVATE_INVALID_LOBBY', 'A lobby cannot be used', broken);
        }
        if (settings.enabled && lobbies.length === 0) {
          throw new ApiError(400, 'PRIVATE_INCOMPLETE', 'An enabled module needs a lobby');
        }
        request.audit({
          action: 'automation.private',
          targetType: 'settings',
          targetId: 'automation.private',
          details: {
            enabled: settings.enabled,
            dryRun: settings.dryRun,
            lobbies: lobbies.map((lobby) => ({
              id: lobby.id,
              lobbyChannelId: lobby.lobbyChannelId,
              parentId: lobby.parentId,
            })),
          },
        });
        saveModuleSettings(db, 'private', settings, context.now());
        return response();
      },
    );

    return Promise.resolve();
  };
}

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiContext } from '../context.js';

export const onlineResponse = z.object({
  /** False when the query connection is down: the list would be outdated, so it is empty. */
  connected: z.boolean(),
  items: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string(),
      channelId: z.number().int(),
      channelName: z.string().nullable(),
      state: z.enum(['active', 'idle', 'afk']).nullable(),
      since: z.number().int(),
    }),
  ),
});

/** `GET /api/online`: players connected right now, grouped by channel. */
export function onlineRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const channelName = context.database.sqlite
      .prepare('SELECT name FROM channels WHERE id = ?')
      .pluck();
    app.get('/online', { schema: { response: { 200: onlineResponse } } }, () => {
      const connected = context.ts3?.state === 'connected' && context.live !== undefined;
      if (!connected || !context.live) return { connected: false, items: [] };
      const items = context.live
        .liveClients()
        .map((client) => ({
          userId: client.userId,
          nickname: client.nickname,
          channelId: client.channelId,
          channelName: (channelName.get(client.channelId) as string | undefined) ?? null,
          state: client.state ?? null,
          since: client.since,
        }))
        .sort(
          (a, b) =>
            (a.channelName ?? '').localeCompare(b.channelName ?? '', 'de') ||
            a.nickname.localeCompare(b.nickname, 'de'),
        );
      return { connected: true, items };
    });
    return Promise.resolve();
  };
}

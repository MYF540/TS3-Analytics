import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { channelUsage, unusedChannels } from '../../db/queries/channels.js';
import { rangeSeconds } from '../../domain/periods.js';
import type { ApiContext } from '../context.js';

const MAX_ITEMS = 100;
/**
 * Channel time is read from `activity_segments`, so a long range scans millions of rows: a year
 * measured 351 ms against the 100 ms budget (docs/performance.md). Short ranges answer the
 * question anyway – which channels are in use now.
 */
export const CHANNEL_RANGES = ['24h', '7d', '30d'] as const;
/** A channel counts as existing when it was in the channel list within the last day. */
const PRESENT_S = 86_400;
/** Segments are kept for months, so asking about a longer period would only mislead. */
const UNUSED_DAYS = [7, 14, 30, 60, 90] as const;

const usageQuery = z.object({ range: z.enum(CHANNEL_RANGES).default('30d') });
const unusedQuery = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((value): value is (typeof UNUSED_DAYS)[number] =>
      (UNUSED_DAYS as readonly number[]).includes(value),
    )
    .default(30),
});

export const channelUsageResponse = z.object({
  range: z.enum(CHANNEL_RANGES),
  from: z.number().int(),
  to: z.number().int(),
  /** Channels with time in the range, even when more than the returned items. */
  total: z.number().int(),
  totalSeconds: z.number().int(),
  items: z.array(
    z.object({
      channelId: z.number().int().nullable(),
      name: z.string().nullable(),
      seconds: z.number().int(),
      users: z.number().int(),
      visits: z.number().int(),
      lastUsed: z.number().int(),
      present: z.boolean(),
    }),
  ),
});

export const unusedChannelsResponse = z.object({
  days: z.number().int(),
  since: z.number().int(),
  items: z.array(
    z.object({
      channelId: z.number().int(),
      name: z.string(),
      lastSeen: z.number().int(),
    }),
  ),
});

/** `GET /api/channels/usage` and `/api/channels/unused` (T7.4). */
export function channelRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;

    app.get(
      '/channels/usage',
      { schema: { querystring: usageQuery, response: { 200: channelUsageResponse } } },
      (request) => {
        const now = context.now();
        const { from, to } = rangeSeconds(request.query.range, now, now);
        return {
          range: request.query.range,
          from,
          to,
          ...channelUsage(sqlite, { from, to, limit: MAX_ITEMS, presentSince: now - PRESENT_S }),
        };
      },
    );

    app.get(
      '/channels/unused',
      { schema: { querystring: unusedQuery, response: { 200: unusedChannelsResponse } } },
      (request) => {
        const now = context.now();
        const since = now - request.query.days * 86_400;
        return {
          days: request.query.days,
          since,
          items: unusedChannels(sqlite, { since, now, presentSince: now - PRESENT_S }),
        };
      },
    );
    return Promise.resolve();
  };
}

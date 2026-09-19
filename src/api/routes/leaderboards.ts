import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  countLeaderboardAllTime,
  countLeaderboardForDays,
  leaderboardAllTime,
  leaderboardForDays,
} from '../../db/queries/stats.js';
import { LEADERBOARD_PERIODS, rollingDays } from '../../domain/periods.js';
import { berlinDay } from '../../domain/time.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';
import { dayParam, leaderboardEntry, pageQuery } from '../schemas.js';

export const LEADERBOARD_METRICS = ['online', 'active', 'longestSession'] as const;

export const leaderboardQuery = pageQuery.extend({
  period: z.enum(LEADERBOARD_PERIODS).default('all'),
  metric: z.enum(LEADERBOARD_METRICS).default('online'),
  from: dayParam.optional(),
  to: dayParam.optional(),
});

export const leaderboardResponse = z.object({
  period: z.enum(LEADERBOARD_PERIODS),
  metric: z.enum(LEADERBOARD_METRICS),
  /** Berlin days (YYYYMMDD), null for "all". */
  fromDay: z.number().int().nullable(),
  toDay: z.number().int().nullable(),
  items: z.array(leaderboardEntry),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});

/**
 * `GET /api/leaderboards`: all time (from `user_totals`), rolling week/month/year or a custom day
 * range (from `user_daily_stats`); metric online time, active time or longest session.
 */
export function leaderboardRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;
    app.get(
      '/leaderboards',
      { schema: { querystring: leaderboardQuery, response: { 200: leaderboardResponse } } },
      (request) => {
        const { period, metric, page, pageSize } = request.query;
        const paging = { limit: pageSize, offset: (page - 1) * pageSize };
        const base = { period, metric, page, pageSize };

        if (period === 'all') {
          return {
            ...base,
            fromDay: null,
            toDay: null,
            items: leaderboardAllTime(sqlite, metric, paging),
            total: countLeaderboardAllTime(sqlite, metric),
          };
        }

        let range = rollingDays(period, berlinDay(context.now()));
        if (period === 'custom') {
          const { from, to } = request.query;
          if (from === undefined || to === undefined) {
            throw new ApiError(400, 'INVALID_RANGE', 'A custom period needs "from" and "to"');
          }
          if (from > to) throw new ApiError(400, 'INVALID_RANGE', '"from" is after "to"');
          range = { fromDay: from, toDay: to };
        }
        if (!range) throw new ApiError(400, 'INVALID_RANGE', 'Unknown period');
        return {
          ...base,
          ...range,
          items: leaderboardForDays(sqlite, metric, range.fromDay, range.toDay, paging),
          total: countLeaderboardForDays(sqlite, metric, range.fromDay, range.toDay),
        };
      },
    );
    return Promise.resolve();
  };
}

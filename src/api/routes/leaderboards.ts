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
import { CSV_LABELS, sendCsv } from '../csv.js';
import { dayParam, leaderboardEntry, pageQuery } from '../schemas.js';
import { hours, toCsv } from '../../domain/csv.js';

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

type LeaderboardQuery = z.infer<typeof leaderboardQuery>;

/** Day range of a leaderboard query; `null` means all time (from `user_totals`). */
function resolveRange(
  query: Pick<LeaderboardQuery, 'period' | 'from' | 'to'>,
  now: number,
): { fromDay: number; toDay: number } | null {
  if (query.period === 'all') return null;
  if (query.period === 'custom') {
    if (query.from === undefined || query.to === undefined) {
      throw new ApiError(400, 'INVALID_RANGE', 'A custom period needs "from" and "to"');
    }
    if (query.from > query.to) throw new ApiError(400, 'INVALID_RANGE', '"from" is after "to"');
    return { fromDay: query.from, toDay: query.to };
  }
  const range = rollingDays(query.period, berlinDay(now));
  if (!range) throw new ApiError(400, 'INVALID_RANGE', 'Unknown period');
  return range;
}

const EXPORT_LIMIT = 1_000_000;

/**
 * `GET /api/leaderboards`: all time (from `user_totals`), rolling week/month/year or a custom day
 * range (from `user_daily_stats`); metric online time, active time or longest session.
 * `GET /api/leaderboards/export.csv`: the complete ranking of the same selection as CSV.
 */
export function leaderboardRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;

    const rank = (
      query: Pick<LeaderboardQuery, 'period' | 'metric' | 'from' | 'to'>,
      paging: { limit: number; offset: number },
    ) => {
      const range = resolveRange(query, context.now());
      if (!range) {
        return {
          fromDay: null,
          toDay: null,
          items: leaderboardAllTime(sqlite, query.metric, paging),
          total: () => countLeaderboardAllTime(sqlite, query.metric),
        };
      }
      return {
        ...range,
        items: leaderboardForDays(sqlite, query.metric, range.fromDay, range.toDay, paging),
        total: () => countLeaderboardForDays(sqlite, query.metric, range.fromDay, range.toDay),
      };
    };

    app.get(
      '/leaderboards',
      { schema: { querystring: leaderboardQuery, response: { 200: leaderboardResponse } } },
      (request) => {
        const { period, metric, page, pageSize } = request.query;
        const result = rank(request.query, { limit: pageSize, offset: (page - 1) * pageSize });
        return {
          period,
          metric,
          page,
          pageSize,
          fromDay: result.fromDay,
          toDay: result.toDay,
          items: result.items,
          total: result.total(),
        };
      },
    );

    app.get(
      '/leaderboards/export.csv',
      { schema: { querystring: leaderboardQuery.omit({ page: true, pageSize: true }) } },
      (request, reply) => {
        const result = rank(request.query, { limit: EXPORT_LIMIT, offset: 0 });
        const csv = toCsv(
          [
            CSV_LABELS.rank,
            CSV_LABELS.userId,
            CSV_LABELS.uid,
            CSV_LABELS.nickname,
            `${CSV_LABELS.metric[request.query.metric]} (h)`,
            `${CSV_LABELS.metric[request.query.metric]} (s)`,
            CSV_LABELS.accounts,
          ],
          result.items.map((e) => [
            e.rank,
            e.userId,
            e.uid,
            e.nickname,
            hours(e.value),
            e.value,
            e.accounts,
          ]),
        );
        const range =
          result.fromDay === null ? 'gesamt' : `${String(result.fromDay)}-${String(result.toDay)}`;
        return sendCsv(reply, `leaderboard-${request.query.metric}-${range}.csv`, csv);
      },
    );
    return Promise.resolve();
  };
}

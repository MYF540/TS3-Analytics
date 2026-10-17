import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { personPeriodFigures, serverPeriodFigures } from '../../db/queries/trends.js';
import { berlinDay } from '../../domain/time.js';
import {
  activityCovered,
  comparisonWindows,
  perUnit,
  trend,
  TREND_COMPARISONS,
} from '../../domain/trends.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

export const trendSchema = z.object({
  current: z.number(),
  previous: z.number(),
  change: z.number(),
  /** Null when the earlier value is 0. */
  changePct: z.number().nullable(),
  direction: z.enum(['up', 'flat', 'down']),
});

const dayRange = z.object({ fromDay: z.number().int(), toDay: z.number().int() });

const trendQuery = z.object({ comparison: z.enum(TREND_COMPARISONS).default('month') });

/** Null means "not comparable": one of the periods has too little measured activity. */
const activityTrend = trendSchema.nullable();

export const serverTrendsResponse = z.object({
  comparison: z.enum(TREND_COMPARISONS),
  current: dayRange,
  previous: dayRange,
  metrics: z.object({
    players: trendSchema,
    newPlayers: trendSchema,
    onlineS: trendSchema,
    avgOnlinePerPlayerS: trendSchema,
    activeS: activityTrend,
    avgActivePerPlayerS: activityTrend,
    sessions: trendSchema,
    avgOnline: trendSchema,
    peakOnline: trendSchema,
  }),
});

export const playerTrendsResponse = z.object({
  comparison: z.enum(TREND_COMPARISONS),
  current: dayRange,
  previous: dayRange,
  metrics: z.object({
    onlineS: trendSchema,
    activeS: activityTrend,
    sessions: trendSchema,
    daysOnline: trendSchema,
    avgSessionS: trendSchema,
  }),
});

/**
 * `GET /api/stats/trends` and `GET /api/users/:id/trends`: figures of a recent period compared
 * with an earlier one (see `TrendComparison`), each with its direction (up / flat / down).
 */
export function trendRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;

    app.get(
      '/stats/trends',
      { schema: { querystring: trendQuery, response: { 200: serverTrendsResponse } } },
      (request) => {
        const { comparison } = request.query;
        const windows = comparisonWindows(comparison, berlinDay(context.now()));
        const now = serverPeriodFigures(sqlite, windows.current.fromDay, windows.current.toDay);
        const before = serverPeriodFigures(
          sqlite,
          windows.previous.fromDay,
          windows.previous.toDay,
        );
        const comparable =
          activityCovered(now.onlineS, now.unknownS) &&
          activityCovered(before.onlineS, before.unknownS);
        return {
          comparison,
          ...windows,
          metrics: {
            players: trend(now.players, before.players),
            newPlayers: trend(now.newPlayers, before.newPlayers),
            onlineS: trend(now.onlineS, before.onlineS),
            avgOnlinePerPlayerS: trend(
              perUnit(now.onlineS, now.players),
              perUnit(before.onlineS, before.players),
            ),
            activeS: comparable ? trend(now.activeS, before.activeS) : null,
            avgActivePerPlayerS: comparable
              ? trend(perUnit(now.activeS, now.players), perUnit(before.activeS, before.players))
              : null,
            sessions: trend(now.sessions, before.sessions),
            avgOnline: trend(now.avgOnline, before.avgOnline),
            peakOnline: trend(now.peakOnline, before.peakOnline),
          },
        };
      },
    );

    app.get(
      '/users/:id/trends',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          querystring: trendQuery,
          response: { 200: playerTrendsResponse },
        },
      },
      (request) => {
        const { id } = request.params;
        const user = sqlite.prepare(`SELECT anonymized_at FROM users WHERE id = ?`).get(id) as
          { anonymized_at: number | null } | undefined;
        if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        if (user.anonymized_at !== null) {
          throw new ApiError(410, 'USER_ANONYMIZED', 'The data of this player was anonymized');
        }
        const { comparison } = request.query;
        const windows = comparisonWindows(comparison, berlinDay(context.now()));
        const now = personPeriodFigures(sqlite, id, windows.current.fromDay, windows.current.toDay);
        const before = personPeriodFigures(
          sqlite,
          id,
          windows.previous.fromDay,
          windows.previous.toDay,
        );
        const comparable =
          activityCovered(now.onlineS, now.unknownS) &&
          activityCovered(before.onlineS, before.unknownS);
        return {
          comparison,
          ...windows,
          metrics: {
            onlineS: trend(now.onlineS, before.onlineS),
            activeS: comparable ? trend(now.activeS, before.activeS) : null,
            sessions: trend(now.sessions, before.sessions),
            daysOnline: trend(now.daysOnline, before.daysOnline),
            avgSessionS: trend(
              perUnit(now.onlineS, now.sessions),
              perUnit(before.onlineS, before.sessions),
            ),
          },
        };
      },
    );
    return Promise.resolve();
  };
}

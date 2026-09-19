import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { listUsers, USER_SORTS, userDetail } from '../../db/queries/stats.js';
import { getUserTags } from '../../db/repositories/index.js';
import { tag } from './notes.js';
import { daysBefore } from '../../domain/periods.js';
import { berlinDay } from '../../domain/time.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';
import { csvDateTime, hours, toCsv } from '../../domain/csv.js';
import { CSV_LABELS, sendCsv } from '../csv.js';
import { paged, pageQuery } from '../schemas.js';

/** Users below this all-time online time are "casual" and hidden unless requested. */
export const CASUAL_THRESHOLD_S = 3600;

export const userListQuery = pageQuery.extend({
  search: z.string().trim().max(100).optional(),
  sort: z.enum(USER_SORTS).default('online'),
  order: z.enum(['asc', 'desc']).default('desc'),
  includeCasual: z.stringbool().default(false),
});

export const userListItem = z.object({
  userId: z.number().int(),
  uid: z.string(),
  nickname: z.string().nullable(),
  onlineS: z.number().int(),
  activeS: z.number().int(),
  sessions: z.number().int(),
  firstSeen: z.number().int(),
  lastSeen: z.number().int(),
  country: z.string().nullable(),
  online: z.boolean(),
});

export const userDetailResponse = z.object({
  user: z.object({
    id: z.number().int(),
    uid: z.string(),
    dbid: z.number().int().nullable(),
    nickname: z.string().nullable(),
    firstSeen: z.number().int(),
    lastSeen: z.number().int(),
    platform: z.string().nullable(),
    version: z.string().nullable(),
    country: z.string().nullable(),
  }),
  /** Current session if online. */
  online: z.object({ since: z.number().int() }).nullable(),
  totals: z.object({
    onlineS: z.number().int(),
    activeS: z.number().int(),
    sessions: z.number().int(),
    longestSessionS: z.number().int(),
  }),
  nicknames: z.array(
    z.object({ nick: z.string(), firstSeen: z.number().int(), lastSeen: z.number().int() }),
  ),
  recentSessions: z.array(
    z.object({
      id: z.number().int(),
      joinAt: z.number().int(),
      leaveAt: z.number().int().nullable(),
      duration: z.number().int().nullable(),
      source: z.enum(['live', 'import']),
    }),
  ),
  daily: z.array(
    z.object({
      day: z.number().int(),
      onlineS: z.number().int(),
      activeS: z.number().int(),
      idleS: z.number().int(),
      afkS: z.number().int(),
      unknownS: z.number().int(),
      sessions: z.number().int(),
    }),
  ),
  topChannels: z.array(
    z.object({
      channelId: z.number().int().nullable(),
      name: z.string().nullable(),
      seconds: z.number().int(),
    }),
  ),
  countries: z.array(
    z.object({ country: z.string(), lastSeen: z.number().int(), connections: z.number().int() }),
  ),
  tags: z.array(tag),
});

export function userRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;

    app.get(
      '/users',
      { schema: { querystring: userListQuery, response: { 200: paged(userListItem) } } },
      (request) => {
        const { page, pageSize, search, sort, order, includeCasual } = request.query;
        const result = listUsers(sqlite, {
          search,
          sort,
          order,
          limit: pageSize,
          offset: (page - 1) * pageSize,
          minOnlineS: includeCasual ? 0 : CASUAL_THRESHOLD_S,
        });
        return { ...result, page, pageSize };
      },
    );

    app.get(
      '/users/export.csv',
      { schema: { querystring: userListQuery.omit({ page: true, pageSize: true }) } },
      (request, reply) => {
        const { search, sort, order, includeCasual } = request.query;
        const { items } = listUsers(sqlite, {
          search,
          sort,
          order,
          limit: 1_000_000,
          offset: 0,
          minOnlineS: includeCasual ? 0 : CASUAL_THRESHOLD_S,
        });
        const csv = toCsv(
          [
            CSV_LABELS.userId,
            CSV_LABELS.uid,
            CSV_LABELS.nickname,
            CSV_LABELS.onlineH,
            CSV_LABELS.onlineS,
            CSV_LABELS.activeH,
            CSV_LABELS.activeS,
            CSV_LABELS.sessions,
            CSV_LABELS.firstSeen,
            CSV_LABELS.lastSeen,
            CSV_LABELS.country,
            CSV_LABELS.online,
          ],
          items.map((u) => [
            u.userId,
            u.uid,
            u.nickname,
            hours(u.onlineS),
            u.onlineS,
            hours(u.activeS),
            u.activeS,
            u.sessions,
            csvDateTime(u.firstSeen),
            csvDateTime(u.lastSeen),
            u.country,
            u.online ? CSV_LABELS.yes : CSV_LABELS.no,
          ]),
        );
        return sendCsv(reply, 'spieler.csv', csv);
      },
    );

    app.get(
      '/users/:id',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          querystring: z.object({ days: z.coerce.number().int().min(1).max(3660).default(365) }),
          response: { 200: userDetailResponse },
        },
      },
      (request) => {
        const today = berlinDay(context.now());
        const detail = userDetail(
          sqlite,
          request.params.id,
          daysBefore(today, request.query.days - 1),
        );
        if (!detail) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        const u = detail.user;
        const t = detail.totals;
        return {
          user: {
            id: u.id as number,
            uid: u.uid as string,
            dbid: (u.dbid as number | null) ?? null,
            nickname: (detail.nicknames[0]?.nick as string | undefined) ?? null,
            firstSeen: u.first_seen as number,
            lastSeen: u.last_seen as number,
            platform: (u.platform as string | null) ?? null,
            version: (u.version as string | null) ?? null,
            country: (u.country as string | null) ?? null,
          },
          online: detail.openSession ? { since: detail.openSession.joinAt as number } : null,
          totals: {
            onlineS: (t?.online_s as number | undefined) ?? 0,
            activeS: (t?.active_s as number | undefined) ?? 0,
            sessions: (t?.sessions as number | undefined) ?? 0,
            longestSessionS: (t?.longest_session_s as number | undefined) ?? 0,
          },
          nicknames: detail.nicknames as z.infer<typeof userDetailResponse>['nicknames'],
          recentSessions: detail.recentSessions as z.infer<
            typeof userDetailResponse
          >['recentSessions'],
          daily: detail.daily as z.infer<typeof userDetailResponse>['daily'],
          topChannels: detail.topChannels as z.infer<typeof userDetailResponse>['topChannels'],
          countries: detail.countries as z.infer<typeof userDetailResponse>['countries'],
          tags: getUserTags(context.database.db, request.params.id),
        };
      },
    );
    return Promise.resolve();
  };
}

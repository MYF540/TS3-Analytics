import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loyaltyCohorts, loyaltyMonths, missingRegulars } from '../../db/queries/loyalty.js';
import { hours, toCsv } from '../../domain/csv.js';
import { RECENT_WINDOW_DAYS, RETURN_AFTER_DAYS } from '../../domain/loyalty.js';
import { berlinDay } from '../../domain/time.js';
import { loadLoyaltyState, runLoyaltyJob } from '../../loyalty/job.js';
import type { ApiContext } from '../context.js';
import { CSV_LABELS, sendCsv } from '../csv.js';

export const loyaltyResponse = z.object({
  /** When the daily job last ran; null before the first run. */
  computedAt: z.number().int().nullable(),
  returnAfterDays: z.array(z.number().int()),
  cohorts: z.array(
    z.object({
      month: z.number().int(),
      size: z.number().int(),
      eligible: z.array(z.number().int()),
      returned: z.array(z.number().int()),
    }),
  ),
  months: z.array(
    z.object({
      month: z.number().int(),
      active: z.number().int(),
      newcomers: z.number().int(),
      returners: z.number().int(),
      lost: z.number().int(),
    }),
  ),
});

const missingQuery = z.object({
  /** Online hours in the 90 days before the last visit. */
  minHours: z.coerce.number().min(0).max(2000).default(20),
  /** Away for at least this many weeks. */
  weeks: z.coerce.number().int().min(1).max(520).default(4),
});

export const missingRegularsResponse = z.object({
  computedAt: z.number().int().nullable(),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  items: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      /** YYYYMMDD (Europe/Berlin). */
      lastDay: z.number().int(),
      recentS: z.number().int(),
      totalS: z.number().int(),
      rank: z.string().nullable(),
    }),
  ),
});

const isoDay = (day: number) => {
  const s = String(day);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

/**
 * Retention and churn (T13.1): cohorts and the monthly balance from the daily cache, and the
 * regulars who have been away for a while (all roles). Admins can recompute the cache.
 */
export function loyaltyRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;
    const filter = (q: z.infer<typeof missingQuery>) => ({
      minRecentS: Math.round(q.minHours * 3600),
      lastDayBefore: berlinDay(context.now() - q.weeks * 7 * 86_400),
    });

    const overview = () => ({
      computedAt: loadLoyaltyState(db)?.computedAt ?? null,
      returnAfterDays: [...RETURN_AFTER_DAYS],
      cohorts: loyaltyCohorts(sqlite),
      months: loyaltyMonths(sqlite),
    });

    app.get('/loyalty', { schema: { response: { 200: loyaltyResponse } } }, overview);

    app.get(
      '/loyalty/missing',
      {
        schema: {
          querystring: missingQuery.extend({
            page: z.coerce.number().int().min(1).default(1),
            pageSize: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: { 200: missingRegularsResponse },
        },
      },
      (request) => {
        const { page, pageSize } = request.query;
        const result = missingRegulars(sqlite, {
          ...filter(request.query),
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });
        return {
          computedAt: loadLoyaltyState(db)?.computedAt ?? null,
          ...result,
          page,
          pageSize,
        };
      },
    );

    app.get('/loyalty/missing.csv', { schema: { querystring: missingQuery } }, (request, reply) => {
      const { items } = missingRegulars(sqlite, {
        ...filter(request.query),
        limit: 1_000_000,
        offset: 0,
      });
      const recentH = CSV_LABELS.recentH.replace('{days}', String(RECENT_WINDOW_DAYS));
      const csv = toCsv(
        [
          CSV_LABELS.userId,
          CSV_LABELS.nickname,
          CSV_LABELS.lastVisit,
          recentH,
          CSV_LABELS.onlineH,
          CSV_LABELS.onlineS,
          CSV_LABELS.rankName,
        ],
        items.map((p) => [
          p.userId,
          p.nickname,
          isoDay(p.lastDay),
          hours(p.recentS),
          hours(p.totalS),
          p.totalS,
          p.rank,
        ]),
      );
      return sendCsv(reply, 'vermisste-stammspieler.csv', csv);
    });

    app.post(
      '/loyalty/run',
      { config: { auth: 'admin' }, schema: { response: { 200: loyaltyResponse } } },
      (request) => {
        request.audit({ action: 'loyalty.run', targetType: 'settings', targetId: 'loyalty' });
        runLoyaltyJob(context.database, context.now());
        return overview();
      },
    );

    return Promise.resolve();
  };
}

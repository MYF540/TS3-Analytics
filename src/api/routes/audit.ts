import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { berlinDayStart, nextDay } from '../../domain/time.js';
import { auditFilterValues, listAudit } from '../audit/audit.js';
import type { ApiContext } from '../context.js';
import { dayParam, paged, pageQuery } from '../schemas.js';

export const auditEntry = z.object({
  id: z.number().int(),
  at: z.number().int(),
  actorName: z.string(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
  status: z.number().int().nullable(),
});

export const auditFiltersResponse = z.object({
  actors: z.array(z.string()),
  actions: z.array(z.string()),
});

/** `GET /api/audit` and its filter values – admins only. */
export function auditRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;
    app.get(
      '/audit',
      {
        config: { auth: 'admin' },
        schema: {
          querystring: pageQuery.extend({
            actor: z.string().max(64).optional(),
            action: z.string().max(200).optional(),
            from: dayParam.optional(),
            to: dayParam.optional(),
          }),
          response: { 200: paged(auditEntry) },
        },
      },
      (request) => {
        const { actor, action, from, to, page, pageSize } = request.query;
        const result = listAudit(
          sqlite,
          {
            actor,
            action,
            from: from === undefined ? undefined : berlinDayStart(from),
            to: to === undefined ? undefined : berlinDayStart(nextDay(to)),
          },
          { limit: pageSize, offset: (page - 1) * pageSize },
        );
        return { ...result, page, pageSize };
      },
    );

    app.get(
      '/audit/filters',
      { config: { auth: 'admin' }, schema: { response: { 200: auditFiltersResponse } } },
      () => auditFilterValues(sqlite),
    );
    return Promise.resolve();
  };
}

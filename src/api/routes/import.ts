import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { compareImportedTimes, importedLogSeconds } from '../../db/queries/import-comparison.js';
import { getUserById } from '../../db/repositories/index.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

/** Differences below this are normal: the two sources never measure exactly the same. */
const TOLERANCE_S = 3600;

const query = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  /** Default: only players both sources know; the rest cannot be compared. */
  both: z
    .enum(['0', '1'])
    .default('1')
    .transform((value) => value === '1'),
});

export const importComparisonResponse = z.object({
  items: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      placeholder: z.boolean(),
      logS: z.number().int(),
      legacyS: z.number().int(),
      diffS: z.number().int(),
    }),
  ),
  total: z.number().int(),
  matching: z.number().int(),
  toleranceS: z.number().int(),
});

const decision = z.object({
  /** `logs`: take the time from the server logs as ranking time; `legacy`: keep what is stored. */
  use: z.enum(['logs', 'legacy']),
});

export const importDecisionResponse = z.object({ legacyS: z.number().int() });

/**
 * Plausibility report for the historical import (T8.10), admins only. The decision per player
 * goes to the audit log – with the internal id, never the UID.
 */
export function importRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;

    app.get(
      '/import/comparison',
      {
        config: { auth: 'admin' },
        schema: { querystring: query, response: { 200: importComparisonResponse } },
      },
      (request) => {
        const { page, pageSize } = request.query;
        const result = compareImportedTimes(sqlite, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
          toleranceS: TOLERANCE_S,
          bothSources: request.query.both,
        });
        return { ...result, toleranceS: TOLERANCE_S };
      },
    );

    app.post(
      '/import/comparison/:id',
      {
        config: { auth: 'admin' },
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: decision,
          response: { 200: importDecisionResponse },
        },
      },
      (request) => {
        const { id } = request.params;
        const user = getUserById(db, id);
        if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        const before = user.legacySeconds;
        const legacyS = request.body.use === 'logs' ? importedLogSeconds(sqlite, id) : before;
        if (legacyS !== before) {
          sqlite.prepare(`UPDATE users SET legacy_seconds = ? WHERE id = ?`).run(legacyS, id);
        }
        request.audit({
          action: 'import.decision',
          targetType: 'user',
          targetId: id,
          details: { use: request.body.use, before, after: legacyS },
        });
        return { legacyS };
      },
    );
    return Promise.resolve();
  };
}

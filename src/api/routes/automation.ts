import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AUTOMATION_LOG_RETENTION_DAYS, listAutomationLog } from '../../automation/log.js';
import { moduleStates } from '../../automation/registry.js';
import { AUTOMATION_MODULES, AUTOMATION_RESULTS } from '../../db/schema.js';
import type { ApiContext } from '../context.js';
import { paged, pageQuery } from '../schemas.js';

export const automationOverviewResponse = z.object({
  modules: z.array(
    z.object({
      id: z.enum(AUTOMATION_MODULES),
      enabled: z.boolean(),
      /** Test mode: the module only records what it would do. */
      dryRun: z.boolean(),
    }),
  ),
  /** Days an entry of the log is kept. */
  retentionDays: z.number().int(),
});

export const automationLogEntry = z.object({
  id: z.number().int(),
  at: z.number().int(),
  module: z.enum(AUTOMATION_MODULES),
  action: z.string(),
  userId: z.number().int().nullable(),
  nickname: z.string().nullable(),
  detail: z.string().nullable(),
  result: z.enum(AUTOMATION_RESULTS),
});

/** Overview of the bot modules and what they did (T10.2) – admins only. */
export function automationRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db, sqlite } = context.database;

    app.get(
      '/automation',
      { config: { auth: 'admin' }, schema: { response: { 200: automationOverviewResponse } } },
      () => ({ modules: moduleStates(db), retentionDays: AUTOMATION_LOG_RETENTION_DAYS }),
    );

    app.get(
      '/automation/log',
      {
        config: { auth: 'admin' },
        schema: {
          querystring: pageQuery.extend({ module: z.enum(AUTOMATION_MODULES).optional() }),
          response: { 200: paged(automationLogEntry) },
        },
      },
      (request) => {
        const { module, page, pageSize } = request.query;
        const result = listAutomationLog(sqlite, {
          module,
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });
        return { ...result, page, pageSize };
      },
    );

    return Promise.resolve();
  };
}

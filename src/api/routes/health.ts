import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ApiContext } from '../context.js';

export const healthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  uptimeS: z.number().int(),
  db: z.object({ ok: z.boolean(), latencyMs: z.number() }),
  ts3: z.object({ state: z.string(), connected: z.boolean() }),
});

export type HealthResponse = z.infer<typeof healthResponse>;

/** `GET /api/health`: 200 when the database works (degraded without TS3), 503 otherwise. */
export function healthRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    app.get(
      '/health',
      { schema: { response: { 200: healthResponse, 503: healthResponse } } },
      async (_request, reply) => {
        const started = performance.now();
        let dbOk = true;
        try {
          context.database.sqlite.prepare('SELECT 1').get();
        } catch {
          dbOk = false;
        }
        const latencyMs = Math.round((performance.now() - started) * 100) / 100;
        const state = context.ts3?.state ?? 'disabled';
        const connected = state === 'connected';
        const body: HealthResponse = {
          status: !dbOk ? 'down' : connected ? 'ok' : 'degraded',
          uptimeS: Math.max(0, context.now() - context.startedAt),
          db: { ok: dbOk, latencyMs },
          ts3: { state, connected },
        };
        return reply.status(dbOk ? 200 : 503).send(body);
      },
    );
    return Promise.resolve();
  };
}

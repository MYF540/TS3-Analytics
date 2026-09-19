import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Config } from '../config/config.js';
import type { ApiContext } from './context.js';
import { errorBody, registerErrorHandler } from './errors.js';
import { registerAudit } from './audit/plugin.js';
import { registerAuth, type RouteAuth } from './auth/plugin.js';
import { auditRoutes } from './routes/audit.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { leaderboardRoutes } from './routes/leaderboards.js';
import { onlineRoutes } from './routes/online.js';
import { statsRoutes } from './routes/stats.js';
import { userRoutes } from './routes/users.js';

/** Built frontend (`web/dist`), same relative location from `src/api` and `dist/api`. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../web/dist', import.meta.url));

/** A registered API route and its access level (used to test every route's protection). */
export interface RouteInfo {
  method: string;
  url: string;
  auth: RouteAuth;
}

declare module 'fastify' {
  interface FastifyInstance {
    apiRoutes: RouteInfo[];
  }
}

export interface ServerOptions {
  /** Directory with the built frontend; not served when missing. */
  webRoot?: string | undefined;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

/** Builds the HTTP app without listening (tests use `inject`). */
export async function buildServer(
  context: ApiContext,
  options: ServerOptions = {},
): Promise<FastifyInstance> {
  // Widened on purpose: Fastify infers its logger generic from this option.
  const logger: FastifyBaseLogger = context.logger;
  const app = Fastify({
    loggerInstance: logger,
    // Per-request logs only at debug level; errors are logged by the error handler.
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  const apiRoutes: RouteInfo[] = [];
  app.decorate('apiRoutes', apiRoutes);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    for (const method of [route.method].flat()) {
      if (method === 'HEAD') continue;
      apiRoutes.push({ method, url: route.url, auth: route.config?.auth ?? 'viewer' });
    }
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    done(null, payload);
  });
  app.addHook('onResponse', (request, reply, done) => {
    request.log.debug(
      { method: request.method, url: request.url, status: reply.statusCode },
      'HTTP request',
    );
    done();
  });

  // Protects every /api route by default (see auth/plugin.ts).
  await registerAuth(app, context);
  // Records every state-changing request (AGENTS.md rule 10).
  registerAudit(app, context);

  await app.register(
    async (api) => {
      await api.register(authRoutes(context));
      await api.register(healthRoutes(context));
      await api.register(statsRoutes(context));
      await api.register(userRoutes(context));
      await api.register(leaderboardRoutes(context));
      await api.register(onlineRoutes(context));
      await api.register(auditRoutes(context));
    },
    { prefix: '/api' },
  );

  const webRoot = options.webRoot;
  const hasFrontend = webRoot !== undefined && existsSync(join(webRoot, 'index.html'));
  if (hasFrontend) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    if (!isApi && hasFrontend && request.method === 'GET') {
      // Single-page app: client-side routes are answered with index.html.
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(errorBody('NOT_FOUND', 'Route not found'));
  });

  return app;
}

/** Starts listening on the configured loopback address (AGENTS.md rule 8). */
export async function startServer(
  context: ApiContext,
  web: Config['web'],
  options: ServerOptions = { webRoot: DEFAULT_WEB_ROOT },
): Promise<FastifyInstance> {
  const app = await buildServer(context, options);
  await app.listen({ host: web.host, port: web.port });
  context.logger.info({ host: web.host, port: web.port }, 'Web interface listening');
  return app;
}

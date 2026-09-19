import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ADMIN_ROLES } from '../../db/schema.js';
import { LoginThrottle } from '../../domain/login-throttle.js';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from '../auth/plugin.js';
import { authenticate, createSession, deleteSession, normalizeUsername } from '../auth/service.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

export const authUser = z.object({
  id: z.number().int(),
  username: z.string(),
  role: z.enum(ADMIN_ROLES),
});

export const authResponse = z.object({ user: authUser });

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

/** Login, logout and the current user. */
export function authRoutes(context: ApiContext): FastifyPluginAsyncZod {
  const throttle = new LoginThrottle();
  return (app) => {
    app.post(
      '/auth/login',
      {
        config: { auth: 'public' },
        schema: { body: loginBody, response: { 200: authResponse } },
      },
      async (request, reply) => {
        const username = normalizeUsername(request.body.username);
        const now = context.now();
        const decision = throttle.check(username, now);
        if (!decision.allowed) {
          request.audit({ action: 'auth.login_blocked', details: { username } });
          void reply.header('retry-after', String(decision.retryAfterS));
          throw new ApiError(429, 'RATE_LIMITED', 'Too many failed logins', {
            retryAfterS: decision.retryAfterS,
          });
        }
        const user = await authenticate(context.database.db, username, request.body.password);
        if (!user) {
          throttle.recordFailure(username, now);
          request.audit({ action: 'auth.login_failed', details: { username } });
          request.log.warn({ username }, 'Failed login');
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
        }
        throttle.recordSuccess(username);
        request.audit({
          action: 'auth.login',
          actorId: user.id,
          actorName: user.username,
          targetType: 'admin_user',
          targetId: user.id,
        });
        const token = createSession(context.database.db, user.id, now, context.auth.sessionTtlS);
        request.log.info({ username: user.username, role: user.role }, 'Login');
        setSessionCookie(reply, context, token);
        return { user };
      },
    );

    app.post('/auth/logout', { config: { auth: 'public' } }, (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      request.audit({ action: 'auth.logout' });
      if (token) deleteSession(context.database.db, token);
      clearSessionCookie(reply, context);
      return reply.status(204).send();
    });

    app.get('/auth/me', { schema: { response: { 200: authResponse } } }, (request) => {
      if (!request.user) throw new ApiError(401, 'UNAUTHORIZED', 'Login required');
      return { user: request.user };
    });
    return Promise.resolve();
  };
}

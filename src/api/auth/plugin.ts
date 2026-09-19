import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminRole } from '../../db/schema.js';
import type { ApiContext } from '../context.js';
import { errorBody } from '../errors.js';
import { hasRole, resolveSession, type AuthUser } from './service.js';

/** Minimum access level of a route: `public` or the lowest role allowed. Default: `viewer`. */
export type RouteAuth = 'public' | AdminRole;

declare module 'fastify' {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    /** Logged-in user, resolved from the session cookie. */
    user: AuthUser | undefined;
  }
}

export const SESSION_COOKIE = 'ts3a_session';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function setSessionCookie(
  reply: FastifyReply,
  context: ApiContext,
  token: string,
): FastifyReply {
  return reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: context.auth.cookieSecure,
    path: '/',
    maxAge: context.auth.sessionTtlS,
  });
}

export function clearSessionCookie(reply: FastifyReply, context: ApiContext): FastifyReply {
  return reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: context.auth.cookieSecure,
    path: '/',
  });
}

/** A browser sends `Origin` on cross-site requests; it must match our own host. */
function isCrossSite(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== request.headers.host;
  } catch {
    return true;
  }
}

/**
 * Authentication and authorisation for every `/api` route. Routes are protected by default
 * (logged-in viewer); `config: { auth: 'public' }` opens a route, `auth: 'admin'` etc. raises
 * the requirement. State-changing requests from another origin are rejected (CSRF), in addition
 * to the SameSite=Strict session cookie.
 */
export async function registerAuth(app: FastifyInstance, context: ApiContext): Promise<void> {
  await app.register(fastifyCookie);
  app.decorateRequest('user', undefined);

  app.addHook('onRequest', (request, reply, done) => {
    if (request.url !== '/api' && !request.url.startsWith('/api/')) {
      done();
      return;
    }
    if (!SAFE_METHODS.has(request.method) && isCrossSite(request)) {
      void reply.status(403).send(errorBody('CSRF', 'Cross-site request rejected'));
      return;
    }
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      request.user = resolveSession(
        context.database.db,
        token,
        context.now(),
        context.auth.sessionTtlS,
      );
    }
    const required = request.routeOptions.config.auth ?? 'viewer';
    if (required === 'public') {
      done();
      return;
    }
    if (!request.user) {
      void reply.status(401).send(errorBody('UNAUTHORIZED', 'Login required'));
      return;
    }
    if (!hasRole(request.user.role, required)) {
      void reply.status(403).send(errorBody('FORBIDDEN', 'Insufficient role'));
      return;
    }
    done();
  });
}

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';
import { SESSION_COOKIE } from './plugin.js';
import {
  AccountError,
  authenticate,
  createAdminUser,
  createSession,
  deleteExpiredSessions,
  resolveSession,
  setDisabled,
  setPassword,
} from './service.js';

const PASSWORD = 'correct horse battery';
let database: AppDatabase;
let now: number;
let context: ApiContext;

beforeEach(() => {
  database = createTestDatabase();
  now = 1_789_800_000;
  context = createTestContext(database, { now: () => now });
});

afterEach(() => {
  database.close();
});

describe('accounts', () => {
  it('stores only an argon2id hash', async () => {
    await createAdminUser(
      database.db,
      { username: 'Alice', password: PASSWORD, role: 'admin' },
      now,
    );
    const row = database.sqlite
      .prepare('SELECT username, password_hash FROM admin_users')
      .get() as {
      username: string;
      password_hash: string;
    };
    expect(row.username).toBe('alice'); // case-insensitive usernames
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(PASSWORD);
  });

  it('rejects weak passwords, invalid names and duplicates', async () => {
    const create = (username: string, password: string) =>
      createAdminUser(database.db, { username, password, role: 'viewer' }, now);
    await expect(create('alice', 'short')).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    await expect(create('a', PASSWORD)).rejects.toMatchObject({ code: 'INVALID_USERNAME' });
    await expect(create('bad name', PASSWORD)).rejects.toBeInstanceOf(AccountError);
    await create('alice', PASSWORD);
    await expect(create('ALICE', PASSWORD)).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('authenticates with the right password only', async () => {
    await createAdminUser(
      database.db,
      { username: 'alice', password: PASSWORD, role: 'moderator' },
      now,
    );
    expect(await authenticate(database.db, 'Alice', PASSWORD)).toMatchObject({
      username: 'alice',
      role: 'moderator',
    });
    expect(await authenticate(database.db, 'alice', 'wrong password!!')).toBeUndefined();
    expect(await authenticate(database.db, 'nobody', PASSWORD)).toBeUndefined();
    setDisabled(database.db, 'alice', true);
    expect(await authenticate(database.db, 'alice', PASSWORD)).toBeUndefined();
  });

  it('ends all sessions when the password changes or the account is disabled', async () => {
    const user = await createAdminUser(
      database.db,
      { username: 'alice', password: PASSWORD, role: 'admin' },
      now,
    );
    const first = createSession(database.db, user.id, now, 3600);
    await setPassword(database.db, 'alice', 'another long password');
    expect(resolveSession(database.db, first, now, 3600)).toBeUndefined();

    const second = createSession(database.db, user.id, now, 3600);
    setDisabled(database.db, 'alice', true);
    expect(resolveSession(database.db, second, now, 3600)).toBeUndefined();
    await expect(setPassword(database.db, 'ghost', PASSWORD)).rejects.toMatchObject({
      code: 'UNKNOWN_USER',
    });
  });
});

describe('sessions', () => {
  it('stores only a hash of the token and slides the expiry on use', async () => {
    const user = await createAdminUser(
      database.db,
      { username: 'alice', password: PASSWORD, role: 'viewer' },
      now,
    );
    const token = createSession(database.db, user.id, now, 3600);
    const stored = database.sqlite
      .prepare('SELECT token_hash FROM admin_sessions')
      .pluck()
      .get() as Buffer;
    expect(stored).toHaveLength(32);
    expect(stored.toString('latin1')).not.toContain(token);

    expect(resolveSession(database.db, token, now + 3000, 3600)).toMatchObject({
      username: 'alice',
    });
    // Used at +3000 → valid until +6600, although created with a one-hour lifetime.
    expect(resolveSession(database.db, token, now + 6000, 3600)).toBeDefined();
    expect(resolveSession(database.db, token, now + 6000 + 3601, 3600)).toBeUndefined();
    expect(resolveSession(database.db, 'forged-token', now, 3600)).toBeUndefined();
  });

  it('cleans up expired sessions', async () => {
    const user = await createAdminUser(
      database.db,
      { username: 'alice', password: PASSWORD, role: 'viewer' },
      now,
    );
    createSession(database.db, user.id, now, 10);
    createSession(database.db, user.id, now, 1000);
    expect(deleteExpiredSessions(database.db, now + 100)).toBe(1);
  });
});

describe('HTTP', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await createAdminUser(
      database.db,
      { username: 'alice', password: PASSWORD, role: 'admin' },
      now,
    );
    app = await buildServer(context);
  });

  afterEach(async () => {
    await app.close();
  });

  const login = (username: string, password: string, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
      headers,
    });

  it('logs in with a secure session cookie, knows the user and logs out', async () => {
    const res = await login('Alice', PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ user: { username: 'alice', role: 'admin' } });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[\\w-]{43};`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const cookie = setCookie.split(';')[0] ?? '';

    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { username: 'alice' } });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=;`);
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('answers wrong passwords and unknown users identically', async () => {
    const wrong = await login('alice', 'wrong password!!');
    const unknown = await login('mallory', 'wrong password!!');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('throttles repeated failed logins', async () => {
    for (let i = 0; i < 5; i++)
      expect((await login('alice', `wrong-${String(i)}`)).statusCode).toBe(401);
    const blocked = await login('alice', PASSWORD); // even the right password is refused now
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('900');
    expect(blocked.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', details: { retryAfterS: 900 } },
    });
    now += 901;
    expect((await login('alice', PASSWORD)).statusCode).toBe(200);
  });

  it('rejects state-changing requests from other origins (CSRF)', async () => {
    const res = await login('alice', PASSWORD, {
      origin: 'https://evil.example',
      host: 'localhost',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'CSRF' } });
    const same = await login('alice', PASSWORD, { origin: 'http://localhost', host: 'localhost' });
    expect(same.statusCode).toBe(200);
  });

  it('validates the login body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('permissions of every API route', () => {
  it('requires a login for every route except the explicitly public ones', async () => {
    const app = await buildServer(context);
    const publicRoutes = app.apiRoutes
      .filter((r) => r.auth === 'public')
      .map((r) => `${r.method} ${r.url}`);
    expect(publicRoutes.sort()).toEqual([
      'GET /api/health',
      'POST /api/auth/login',
      'POST /api/auth/logout',
    ]);
    expect(app.apiRoutes.length).toBeGreaterThan(10);

    const viewer = sessionCookie(context, 'viewer');
    for (const route of app.apiRoutes.filter((r) => r.auth !== 'public')) {
      const url = route.url.replace(':id', '1');
      const anonymous = await app.inject({ method: route.method as 'GET', url });
      expect(anonymous.statusCode, `${route.method} ${route.url}`).toBe(401);
      const asViewer = await app.inject({
        method: route.method as 'GET',
        url,
        headers: { cookie: viewer },
      });
      const expected = route.auth === 'viewer' ? 'allowed' : 'forbidden';
      expect(
        asViewer.statusCode === 403 ? 'forbidden' : 'allowed',
        `${route.method} ${route.url}`,
      ).toBe(expected);
    }
    await app.close();
  });

  it('enforces role hierarchy for routes that require more than viewer', async () => {
    const app = await buildServer(context);
    app.get('/api/test/admin-only', { config: { auth: 'admin' } }, () => ({ ok: true }));
    app.get('/api/test/moderation', { config: { auth: 'moderator' } }, () => ({ ok: true }));
    const status = async (url: string, role: 'viewer' | 'moderator' | 'admin') =>
      (await app.inject({ method: 'GET', url, headers: { cookie: sessionCookie(context, role) } }))
        .statusCode;
    expect(await status('/api/test/admin-only', 'viewer')).toBe(403);
    expect(await status('/api/test/admin-only', 'moderator')).toBe(403);
    expect(await status('/api/test/admin-only', 'admin')).toBe(200);
    expect(await status('/api/test/moderation', 'viewer')).toBe(403);
    expect(await status('/api/test/moderation', 'moderator')).toBe(200);
    expect(await status('/api/test/moderation', 'admin')).toBe(200);
    await app.close();
  });
});

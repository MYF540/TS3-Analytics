import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createAdminUser } from '../auth/service.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';
import { writeAudit } from './audit.js';

const PASSWORD = 'correct horse battery';
let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let now: number;

const entries = () =>
  database.sqlite
    .prepare(
      'SELECT actor_name AS actor, action, target_type AS targetType, target_id AS targetId, details, status FROM audit_log ORDER BY id',
    )
    .all() as {
    actor: string;
    action: string;
    targetType: string | null;
    targetId: string | null;
    details: string | null;
    status: number | null;
  }[];

beforeEach(async () => {
  database = createTestDatabase();
  now = 1_789_800_000;
  context = createTestContext(database, { now: () => now });
  await createAdminUser(database.db, { username: 'alice', password: PASSWORD, role: 'admin' }, now);
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('audit middleware', () => {
  it('writes an entry for every state-changing API route', async () => {
    const writing = app.apiRoutes.filter((r) => r.method !== 'GET');
    expect(writing.length).toBeGreaterThan(0);
    const admin = sessionCookie(context, 'admin');
    for (const route of writing) {
      const url = route.url.replace(/:\w+/g, '1');
      const before = entries().length;
      await app.inject({
        method: route.method as 'POST',
        url,
        headers: { cookie: admin },
        payload: {},
      });
      await app.inject({ method: route.method as 'POST', url, payload: {} }); // anonymous
      expect(entries().length, `${route.method} ${route.url}`).toBe(before + 2);
    }
  });

  it('does not record read-only requests', async () => {
    const cookie = sessionCookie(context, 'admin');
    await app.inject({ method: 'GET', url: '/api/stats/overview', headers: { cookie } });
    await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } });
    expect(entries()).toEqual([]);
  });

  it('records logins, failed logins and logouts without ever storing a password', async () => {
    const failed = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'wrong-password-123' },
    });
    expect(failed.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: PASSWORD },
    });
    const cookie = String(ok.headers['set-cookie']).split(';')[0] ?? '';
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });

    expect(entries()).toEqual([
      {
        actor: 'anonymous',
        action: 'auth.login_failed',
        targetType: null,
        targetId: null,
        details: '{"username":"alice"}',
        status: 401,
      },
      {
        actor: 'alice',
        action: 'auth.login',
        targetType: 'admin_user',
        targetId: '1',
        details: null,
        status: 200,
      },
      {
        actor: 'alice',
        action: 'auth.logout',
        targetType: null,
        targetId: null,
        details: null,
        status: 204,
      },
    ]);
    const everything = JSON.stringify(database.sqlite.prepare('SELECT * FROM audit_log').all());
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('wrong-password-123');
  });

  it('records blocked logins', async () => {
    for (let i = 0; i < 6; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'alice', password: `nope-${String(i)}` },
      });
    }
    expect(entries().at(-1)).toMatchObject({ action: 'auth.login_blocked', status: 429 });
  });
});

describe('GET /api/audit', () => {
  beforeEach(() => {
    const add = (at: number, actorName: string, action: string) => {
      writeAudit(database.db, { at, actorId: null, actorName, action, details: { n: at } });
    };
    add(now - 3 * 86_400, 'alice', 'rank.update');
    add(now - 86_400, 'bob', 'note.create');
    add(now - 100, 'alice', 'note.create');
  });

  it('is only available to admins', async () => {
    for (const role of ['viewer', 'moderator'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/audit',
        headers: { cookie: sessionCookie(context, role) },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('lists entries newest first with filters and pagination', async () => {
    const cookie = sessionCookie(context, 'admin');
    const get = async (query: string) =>
      (await app.inject({ method: 'GET', url: `/api/audit${query}`, headers: { cookie } })).json<{
        items: { actorName: string; action: string; details: unknown }[];
        total: number;
      }>();

    const all = await get('');
    expect(all.total).toBe(3);
    expect(all.items.map((e) => `${e.actorName}:${e.action}`)).toEqual([
      'alice:note.create',
      'bob:note.create',
      'alice:rank.update',
    ]);
    expect(all.items[0]?.details).toEqual({ n: now - 100 });

    expect((await get('?actor=alice')).total).toBe(2);
    expect((await get('?action=note.create')).total).toBe(2);
    expect((await get('?action=note.create&actor=bob')).total).toBe(1);
    expect((await get('?from=2026-09-18&to=2026-09-19')).items.map((e) => e.actorName)).toEqual([
      'alice',
      'bob',
    ]);
    const page2 = await get('?pageSize=2&page=2');
    expect(page2.items.map((e) => e.action)).toEqual(['rank.update']);

    const filters = await app.inject({
      method: 'GET',
      url: '/api/audit/filters',
      headers: { cookie },
    });
    expect(filters.json()).toEqual({
      actors: ['alice', 'bob'],
      actions: ['note.create', 'rank.update'],
    });
  });
});

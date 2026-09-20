import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let app: FastifyInstance;
let cookie: string;

function session(uid: string, joinAt: number, source: 'live' | 'import'): void {
  const userId = database.sqlite
    .prepare(`INSERT INTO users (uid, first_seen, last_seen) VALUES (?, ?, ?) RETURNING id`)
    .pluck()
    .get(uid, joinAt, joinAt) as number;
  database.sqlite
    .prepare(
      `INSERT INTO sessions (user_id, join_at, leave_at, duration, source) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(userId, joinAt, joinAt + 3600, 3600, source);
}

beforeEach(async () => {
  database = createTestDatabase();
  const context = createTestContext(database);
  cookie = sessionCookie(context);
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

async function sources() {
  const res = await app.inject({ method: 'GET', url: '/api/stats/sources', headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json<{ importedFrom: number | null; importedTo: number | null; liveSince: number }>();
}

describe('GET /api/stats/sources', () => {
  it('reports nothing imported on a fresh database', async () => {
    expect(await sources()).toEqual({ importedFrom: null, importedTo: null, liveSince: null });
  });

  it('reports the imported period and the start of live tracking (T8.7)', async () => {
    session('uid-a', NOW - 90 * 86_400, 'import');
    session('uid-b', NOW - 40 * 86_400, 'import');
    session('uid-c', NOW - 10 * 86_400, 'live');
    expect(await sources()).toEqual({
      importedFrom: NOW - 90 * 86_400,
      importedTo: NOW - 40 * 86_400,
      liveSince: NOW - 10 * 86_400,
    });
  });

  it('needs a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/sources' });
    expect(res.statusCode).toBe(401);
  });
});

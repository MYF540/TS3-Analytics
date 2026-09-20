import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;
const H = 3600;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;

/** A player with imported log time and a value taken over from the old ranking system. */
function player(uid: string, nick: string, logHours: number, legacyHours: number): number {
  const id = upsertUser(database.db, { uid, seenAt: NOW - 86_400 });
  recordNickname(database.db, id, nick, NOW - 86_400);
  if (logHours > 0) {
    database.sqlite
      .prepare(
        `INSERT INTO sessions (user_id, join_at, leave_at, duration, source)
         VALUES (?, ?, ?, ?, 'import')`,
      )
      .run(id, NOW - 86_400, NOW - 86_400 + logHours * H, logHours * H);
  }
  database.sqlite
    .prepare(`UPDATE users SET legacy_seconds = ? WHERE id = ?`)
    .run(legacyHours * H, id);
  return id;
}

beforeEach(async () => {
  database = createTestDatabase();
  const context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

async function comparison(cookie = admin, query = '') {
  return app.inject({
    method: 'GET',
    url: `/api/import/comparison${query}`,
    headers: { cookie },
  });
}

describe('GET /api/import/comparison', () => {
  it('lists the biggest differences first', async () => {
    const small = player('uid-a', 'Alice', 10, 10);
    const big = player('uid-b', 'Bob', 100, 2);
    const onlyLegacy = player('uid-c', 'Carol', 0, 50);
    player('uid-d', 'Dora', 0, 0); // neither source knows this player

    const body = (await comparison(admin, '?both=0')).json<{
      items: { userId: number; diffS: number; placeholder: boolean }[];
      total: number;
      matching: number;
      toleranceS: number;
    }>();
    expect(body.items.map((i) => i.userId)).toEqual([big, onlyLegacy, small]);
    expect(body.items[0]).toMatchObject({ logS: 100 * H, legacyS: 2 * H, diffS: 98 * H });
    expect(body.items[1]?.diffS).toBe(-50 * H);
    expect(body.total).toBe(3);
    expect(body.matching).toBe(1);
    expect(body.toleranceS).toBe(H);
  });

  it('lists only players both sources know by default', async () => {
    player('uid-a', 'Alice', 10, 10);
    const onlyLegacy = player('uid-c', 'Carol', 0, 50);
    const onlyLogs = player('uid-e', 'Emil', 20, 0);

    const both = (await comparison()).json<{ items: { userId: number }[]; total: number }>();
    expect(both.items.map((i) => i.userId)).not.toContain(onlyLegacy);
    expect(both.items.map((i) => i.userId)).not.toContain(onlyLogs);
    expect(both.total).toBe(1);

    const all = (await comparison(admin, '?both=0')).json<{ total: number }>();
    expect(all.total).toBe(3);
  });

  it('marks placeholders of the log import', async () => {
    player('unknown-dbid-77', 'Geist', 5, 0);
    const body = (await comparison(admin, '?both=0')).json<{ items: { placeholder: boolean }[] }>();
    expect(body.items[0]?.placeholder).toBe(true);
  });

  it('is admin only', async () => {
    expect((await comparison(moderator)).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/import/comparison' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/import/comparison/:id', () => {
  it('takes the log time over as ranking time and records it', async () => {
    const id = player('uid-a', 'Alice', 100, 2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/import/comparison/${String(id)}`,
      headers: { cookie: admin },
      payload: { use: 'logs' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ legacyS: 100 * H });
    expect(
      database.sqlite.prepare(`SELECT legacy_seconds FROM users WHERE id = ?`).pluck().get(id),
    ).toBe(100 * H);
    const audit = database.sqlite
      .prepare(`SELECT action, target_id AS targetId, details FROM audit_log ORDER BY id DESC`)
      .get() as { action: string; targetId: string; details: string };
    expect(audit.action).toBe('import.decision');
    expect(audit.targetId).toBe(String(id));
    expect(JSON.parse(audit.details)).toMatchObject({ use: 'logs', before: 2 * H, after: 100 * H });
  });

  it('keeps the stored value when the admin decides so', async () => {
    const id = player('uid-a', 'Alice', 100, 2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/import/comparison/${String(id)}`,
      headers: { cookie: admin },
      payload: { use: 'legacy' },
    });
    expect(res.json()).toEqual({ legacyS: 2 * H });
    expect(
      database.sqlite.prepare(`SELECT legacy_seconds FROM users WHERE id = ?`).pluck().get(id),
    ).toBe(2 * H);
  });

  it('answers 404 for a player that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/comparison/999',
      headers: { cookie: admin },
      payload: { use: 'logs' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('is admin only', async () => {
    const id = player('uid-a', 'Alice', 100, 2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/import/comparison/${String(id)}`,
      headers: { cookie: moderator },
      payload: { use: 'logs' },
    });
    expect(res.statusCode).toBe(403);
  });
});

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { recordNickname, setSetting, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { FLAGS_LAST_RUN_KEY } from '../../jobs/flag-detection.js';
import { listAudit } from '../audit/audit.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;
let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let moderator: string;
const users: number[] = [];

function insertFlag(fields: {
  pairKey: string;
  kind: string;
  level: string;
  userId: number;
  relatedUserId: number | null;
  status?: string;
  lastDetected?: number;
}) {
  return database.sqlite
    .prepare(
      `INSERT INTO flags (pair_key, kind, level, user_id, related_user_id, status, evidence,
         first_detected, last_detected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .pluck()
    .get(
      fields.pairKey,
      fields.kind,
      fields.level,
      fields.userId,
      fields.relatedUserId,
      fields.status ?? 'open',
      JSON.stringify({ sharedIps: 1, sharedSubnets: 1, lastSeen: NOW - 60 }),
      NOW - 3600,
      fields.lastDetected ?? NOW,
    ) as number;
}

beforeEach(async () => {
  database = createTestDatabase();
  users.length = 0;
  for (const nick of ['Alt', 'Banned', 'Other']) {
    const id = upsertUser(database.db, { uid: `${nick}=`, seenAt: NOW - 86_400 });
    recordNickname(database.db, id, nick, NOW - 86_400);
    users.push(id);
  }
  setSetting(database.db, FLAGS_LAST_RUN_KEY, NOW, NOW);
  context = createTestContext(database);
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('GET /api/flags', () => {
  it('lists open flags by level with nicknames, counts and current state', async () => {
    const [alt = 0, banned = 0, other = 0] = users;
    insertFlag({
      pairKey: 'shared:1:3',
      kind: 'shared_ip',
      level: 'info',
      userId: alt,
      relatedUserId: other,
    });
    insertFlag({
      pairKey: 'ban:1:u2',
      kind: 'ban_ip',
      level: 'high',
      userId: alt,
      relatedUserId: banned,
      lastDetected: NOW - 900,
    });
    insertFlag({
      pairKey: 'x',
      kind: 'ban_subnet',
      level: 'medium',
      userId: other,
      relatedUserId: banned,
      status: 'ignored',
    });

    const res = await app.inject({ url: '/api/flags', headers: { cookie: moderator } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      items: {
        kind: string;
        user: { nickname: string };
        related: { nickname: string };
        current: boolean;
      }[];
      total: number;
      openCounts: Record<string, number>;
    }>();
    expect(body.total).toBe(2);
    expect(body.items.map((f) => [f.kind, f.user.nickname, f.related.nickname, f.current])).toEqual(
      [
        ['ban_ip', 'Alt', 'Banned', false],
        ['shared_ip', 'Alt', 'Other', true],
      ],
    );
    expect(body.openCounts).toEqual({ high: 1, medium: 0, info: 1 });

    const ignored = await app.inject({
      url: '/api/flags?status=ignored',
      headers: { cookie: moderator },
    });
    expect(ignored.json<{ total: number }>().total).toBe(1);
    const forUser = await app.inject({
      url: `/api/flags?status=all&userId=${String(other)}`,
      headers: { cookie: moderator },
    });
    expect(forUser.json<{ total: number }>().total).toBe(2);
  });

  it('is not visible for viewers', async () => {
    const res = await app.inject({
      url: '/api/flags',
      headers: { cookie: sessionCookie(context, 'viewer') },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/flags/:id/status', () => {
  it('records the decision and audits it', async () => {
    const [alt = 0, , other = 0] = users;
    const id = insertFlag({
      pairKey: 'p',
      kind: 'shared_ip',
      level: 'info',
      userId: alt,
      relatedUserId: other,
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/flags/${String(id)}/status`,
      headers: { cookie: moderator },
      payload: { status: 'ignored' },
    });
    expect(res.statusCode).toBe(200);
    const row = database.sqlite
      .prepare('SELECT status, decided_by AS decidedBy, decided_at AS decidedAt FROM flags')
      .get() as { status: string; decidedBy: string; decidedAt: number };
    expect(row).toMatchObject({ status: 'ignored', decidedAt: NOW });
    expect(row.decidedBy).toMatch(/^test-moderator/);
    const [entry] = listAudit(database.sqlite, {}, { limit: 1, offset: 0 }).items;
    expect(entry).toMatchObject({
      action: 'flag.status',
      details: { from: 'open', to: 'ignored' },
    });

    await app.inject({
      method: 'POST',
      url: `/api/flags/${String(id)}/status`,
      headers: { cookie: moderator },
      payload: { status: 'open' },
    });
    expect(database.sqlite.prepare('SELECT decided_by FROM flags').pluck().get()).toBeNull();
  });

  it('rejects unknown flags and statuses', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/flags/99/status',
      headers: { cookie: moderator },
      payload: { status: 'ignored' },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/flags/1/status',
      headers: { cookie: moderator },
      payload: { status: 'deleted' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

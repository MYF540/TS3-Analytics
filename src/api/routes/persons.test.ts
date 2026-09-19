import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { getPersonOfUser, recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { listAudit } from '../audit/audit.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let moderator: string;
let older: number;
let newer: number;

beforeEach(async () => {
  database = createTestDatabase();
  older = upsertUser(database.db, { uid: 'old=', seenAt: 1_700_000_000 });
  newer = upsertUser(database.db, { uid: 'new=', seenAt: 1_780_000_000 });
  recordNickname(database.db, older, 'Original', 1_700_000_000);
  recordNickname(database.db, newer, 'Zweitaccount', 1_780_000_000);
  context = createTestContext(database);
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

function call(method: 'POST' | 'DELETE', url: string, payload?: object, cookie = moderator) {
  return app.inject({
    method,
    url: `/api${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

describe('UID linking API', () => {
  it('links, shows the person in the player detail and audits', async () => {
    const res = await call('POST', `/users/${String(older)}/links`, { userId: newer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      person: { primaryUserId: older, members: [{ userId: older }, { userId: newer }] },
    });
    const detail = await app.inject({
      url: `/api/users/${String(newer)}`,
      headers: { cookie: moderator },
    });
    expect(detail.json()).toMatchObject({
      person: {
        primaryUserId: older,
        members: [{ nickname: 'Original' }, { nickname: 'Zweitaccount' }],
      },
    });
    const [entry] = listAudit(database.sqlite, {}, { limit: 1, offset: 0 }).items;
    expect(entry).toMatchObject({
      action: 'person.link',
      targetId: String(older),
      details: { userId: newer },
      status: 200,
    });
  });

  it('changes the primary user and unlinks', async () => {
    await call('POST', `/users/${String(older)}/links`, { userId: newer });
    const primary = await call('POST', `/users/${String(newer)}/primary`);
    expect(primary.json()).toMatchObject({ person: { primaryUserId: newer } });
    const unlinked = await call('DELETE', `/users/${String(older)}/links`);
    expect(unlinked.json()).toEqual({ person: null });
    expect(getPersonOfUser(database.sqlite, newer)).toBeUndefined();
  });

  it('rejects invalid links', async () => {
    expect(
      (await call('POST', `/users/${String(older)}/links`, { userId: older })).statusCode,
    ).toBe(400);
    expect((await call('POST', `/users/${String(older)}/links`, { userId: 999 })).statusCode).toBe(
      404,
    );
    expect((await call('DELETE', `/users/${String(older)}/links`)).statusCode).toBe(409);
    expect((await call('POST', `/users/${String(older)}/primary`)).statusCode).toBe(409);
    const viewer = sessionCookie(context, 'viewer');
    expect(
      (await call('POST', `/users/${String(older)}/links`, { userId: newer }, viewer)).statusCode,
    ).toBe(403);
  });

  it('links the pair of a flag marked as linked, the older account as primary', async () => {
    const flagId = database.sqlite
      .prepare(
        `INSERT INTO flags (pair_key, kind, level, user_id, related_user_id, evidence,
           first_detected, last_detected)
         VALUES ('shared:x', 'shared_ip', 'info', ?, ?, '{}', 1, 1) RETURNING id`,
      )
      .pluck()
      .get(newer, older) as number;
    const res = await call('POST', `/flags/${String(flagId)}/status`, { status: 'linked' });
    expect(res.statusCode).toBe(200);
    expect(getPersonOfUser(database.sqlite, newer)?.primaryUserId).toBe(older);
  });
});

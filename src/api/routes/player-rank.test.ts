import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { linkUsers, replaceRanks, upsertUser, type Rank } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let admin: string;
let ladder: Rank[];
let userId: number;

function hours(id: number, h: number) {
  database.sqlite
    .prepare(
      `INSERT INTO user_daily_stats (user_id, day, online_s, active_s, idle_s, afk_s, unknown_s,
         sessions, longest_session_s) VALUES (?, 20260901, ?, 0, 0, 0, 0, 1, 0)`,
    )
    .run(id, h * H);
}

beforeEach(async () => {
  database = createTestDatabase();
  ladder = replaceRanks(
    database.sqlite,
    [
      { name: 'Neuling', requiredS: H, serverGroupId: 10 },
      { name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
    ],
    1,
  );
  userId = upsertUser(database.db, { uid: 'a=', seenAt: 1 });
  hours(userId, 20);
  context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

function get(cookie: string, id = userId) {
  return app.inject({ url: `/api/users/${String(id)}/rank`, headers: { cookie } });
}

function put(payload: object, cookie = admin) {
  return app.inject({
    method: 'PUT',
    url: `/api/users/${String(userId)}/rank-override`,
    headers: { cookie },
    payload,
  });
}

describe('player rank API', () => {
  it('shows the current rank and the time to the next one, without overrides for viewers', async () => {
    const res = await get(sessionCookie(context, 'viewer'));
    expect(res.json()).toEqual({
      enabled: true,
      dryRun: true,
      rankingS: 20 * H,
      target: { id: ladder[0]?.id, name: 'Neuling' },
      next: { id: ladder[1]?.id, name: 'Stammgast', remainingS: 30 * H },
      pending: false,
      skipped: null,
      frozen: false,
      override: null,
      ranks: [
        { id: ladder[0]?.id, name: 'Neuling' },
        { id: ladder[1]?.id, name: 'Stammgast' },
      ],
    });
  });

  it('counts linked accounts together', async () => {
    const alt = upsertUser(database.db, { uid: 'b=', seenAt: 1 });
    hours(alt, 40);
    linkUsers(database.sqlite, userId, alt, 'mod', 1);
    const res = await get(admin, alt);
    expect(res.json()).toMatchObject({
      rankingS: 60 * H,
      target: { name: 'Stammgast' },
      next: null,
    });
  });

  it('lets admins set bonus hours, freeze and exclude, with audit', async () => {
    const bonus = await put({
      frozenRankId: null,
      bonusHours: 30.5,
      excluded: false,
      note: 'Event',
    });
    expect(bonus.json()).toMatchObject({
      rankingS: 50.5 * H,
      target: { name: 'Stammgast' },
      override: { bonusS: 30.5 * H, note: 'Event' },
    });
    expect(bonus.json<{ override: { updatedBy: string } }>().override.updatedBy).toMatch(
      /^test-admin/,
    );
    const frozen = await put({
      frozenRankId: ladder[0]?.id,
      bonusHours: 30.5,
      excluded: false,
      note: null,
    });
    expect(frozen.json()).toMatchObject({ target: { name: 'Neuling' }, frozen: true, next: null });
    const excluded = await put({ frozenRankId: null, bonusHours: 0, excluded: true, note: null });
    expect(excluded.json()).toMatchObject({ skipped: 'excluded', target: null });
    const reset = await put({ frozenRankId: null, bonusHours: 0, excluded: false, note: null });
    expect(reset.json()).toMatchObject({ override: null, target: { name: 'Neuling' } });
    const actions = database.sqlite
      .prepare(`SELECT count(*) FROM audit_log WHERE action = 'rank.override'`)
      .pluck()
      .get();
    expect(actions).toBe(4);
  });

  it('validates the frozen rank and permissions', async () => {
    expect(
      (await put({ frozenRankId: 999, bonusHours: 0, excluded: false, note: null })).json(),
    ).toMatchObject({ error: { code: 'UNKNOWN_RANK' } });
    const moderator = sessionCookie(context, 'moderator');
    expect(
      (await put({ frozenRankId: null, bonusHours: 1, excluded: false, note: null }, moderator))
        .statusCode,
    ).toBe(403);
    expect((await get(admin, 999)).statusCode).toBe(404);
  });
});

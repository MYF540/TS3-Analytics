import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAchievementJob } from '../../achievements/job.js';
import { finalizeSession } from '../../db/aggregates.js';
import type { AppDatabase } from '../../db/client.js';
import { linkUsers, openSession, recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { berlinDayStart } from '../../domain/time.js';
import type {
  AchievementHolders,
  AchievementList,
  AchievementSettings,
  PlayerAchievements,
} from '../../../web/src/api/types.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
const DAY = 86_400;
const START = berlinDayStart(20260101) + 18 * H;
const NOW = START + 40 * DAY;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let viewer: string;

function player(uid: string, nick: string): number {
  const id = upsertUser(database.db, { uid, seenAt: START });
  recordNickname(database.db, id, nick, START);
  return id;
}

function daily(userId: number, count: number, hours = 1): void {
  for (let i = 0; i < count; i += 1) {
    const joinAt = START + i * DAY;
    finalizeSession(database, openSession(database.db, userId, joinAt), joinAt + hours * H);
  }
}

beforeEach(async () => {
  database = createTestDatabase();
  const context = createTestContext(database, { now: () => NOW });
  admin = sessionCookie(context, 'admin');
  viewer = sessionCookie(context, 'viewer');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

// The type parameter only names what the test expects back.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
const get = async <T>(url: string, cookie = viewer) => {
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json<T>() };
};

describe('GET /api/achievements', () => {
  it('lists the catalog with holders, rarity base and the latest arrivals', async () => {
    const a = player('a', 'Alice');
    const b = player('b', 'Bob');
    daily(a, 10);
    daily(b, 3);
    runAchievementJob(database, NOW);

    const { status, body } = await get<AchievementList>('/api/achievements');
    expect(status).toBe(200);
    expect(body.persons).toBe(2);
    const regular = body.achievements.find((x) => x.id === 'regular');
    expect(regular).toMatchObject({
      group: 'playtime',
      unit: 'seconds',
      holders: [1, 0, 0, 0, 0],
      latest: { userId: a, nickname: 'Alice', tier: 1 },
      revealed: true,
    });
    expect(body.achievements.find((x) => x.id === 'pioneer')?.holders).toEqual([2]);
    // Secret ones nobody has stay hidden.
    expect(body.achievements.find((x) => x.id === 'jubilee')).toMatchObject({
      secret: true,
      revealed: false,
    });
    // Everything so far was found in the history: nothing counts as "recently reached".
    expect(body.recent).toEqual([]);
    expect(body.state).toMatchObject({ lastRun: NOW, full: true, checked: 2 });
  });

  it('shows tiers reached in a normal run as recent', async () => {
    const a = player('a', 'Alice');
    daily(a, 1, 9);
    runAchievementJob(database, NOW);
    finalizeSession(database, openSession(database.db, a, NOW + 60), NOW + 60 + 2 * H);
    runAchievementJob(database, NOW + 3 * H);
    const { body } = await get<AchievementList>('/api/achievements');
    expect(body.recent).toEqual([
      { userId: a, nickname: 'Alice', achievementId: 'regular', tier: 1, earnedAt: NOW + 3 * H },
    ]);
  });

  it('leaves out disabled achievements', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/achievements',
      headers: { cookie: admin },
      payload: { disabled: ['regular'] },
    });
    const { body } = await get<AchievementList>('/api/achievements');
    expect(body.achievements.some((x) => x.id === 'regular')).toBe(false);
    expect((await get('/api/achievements/regular')).status).toBe(404);
  });
});

describe('GET /api/achievements/:id', () => {
  it('lists holders by highest tier, combining linked accounts', async () => {
    const a = player('a', 'Alice');
    const alt = player('alt', 'Alice2');
    const b = player('b', 'Bob');
    daily(a, 10, 10); // 100 h
    daily(b, 10);
    daily(alt, 1);
    linkUsers(database.sqlite, a, alt, 'admin', NOW);
    runAchievementJob(database, NOW);

    const { status, body } = await get<AchievementHolders>('/api/achievements/regular');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.holders.map((h) => [h.userId, h.tier])).toEqual([
      [a, 2],
      [b, 1],
    ]);
    const paged = await get<AchievementHolders>('/api/achievements/regular?pageSize=1&page=2');
    expect(paged.body.holders.map((h) => h.userId)).toEqual([b]);
    expect((await get('/api/achievements/unknown')).status).toBe(404);
  });
});

describe('GET /api/users/:id/achievements', () => {
  it('returns badges with dates and the progress to the next tier', async () => {
    const a = player('a', 'Alice');
    daily(a, 10, 2);
    runAchievementJob(database, NOW);
    const { status, body } = await get<PlayerAchievements>(`/api/users/${String(a)}/achievements`);
    expect(status).toBe(200);
    const regular = body.achievements.find((x) => x.id === 'regular');
    expect(regular).toMatchObject({
      earned: [{ tier: 1, earnedAt: berlinDayStart(20260105), backfilled: true }],
      value: 20 * H,
      nextThreshold: 100 * H,
    });
    expect(body.achievements.find((x) => x.id === 'streak')).toMatchObject({
      value: 10,
      nextThreshold: 30,
    });
  });

  it('shows the badges of every linked account on each of them', async () => {
    const a = player('a', 'Alice');
    const alt = player('alt', 'Alice2');
    daily(alt, 10);
    runAchievementJob(database, NOW);
    linkUsers(database.sqlite, a, alt, 'admin', NOW);
    const { body } = await get<PlayerAchievements>(`/api/users/${String(a)}/achievements`);
    expect(body.achievements.find((x) => x.id === 'regular')?.earned).toHaveLength(1);
  });

  it('is 404 for unknown and hidden players', async () => {
    expect((await get('/api/users/999/achievements')).status).toBe(404);
    const ghost = player('unknown-dbid-1', 'x');
    expect((await get(`/api/users/${String(ghost)}/achievements`)).status).toBe(404);
  });
});

describe('/api/settings/achievements', () => {
  it('is for admins only', async () => {
    expect((await get('/api/settings/achievements')).status).toBe(403);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/achievements',
      headers: { cookie: viewer },
      payload: { disabled: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('saves the disabled achievements, writes the audit log and runs on demand', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/achievements',
      headers: { cookie: admin },
      payload: { disabled: ['streak', 'regular', 'streak'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AchievementSettings>().disabled).toEqual(['regular', 'streak']);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/achievements',
      headers: { cookie: admin },
      payload: { disabled: ['nope'] },
    });
    expect(bad.statusCode).toBe(400);

    player('a', 'Alice');
    const run = await app.inject({
      method: 'POST',
      url: '/api/settings/achievements/run',
      headers: { cookie: admin },
    });
    expect(run.json<AchievementSettings>().state).toMatchObject({ lastRun: NOW, checked: 1 });

    const actions = database.sqlite
      .prepare('SELECT action FROM audit_log ORDER BY id')
      .pluck()
      .all();
    // The rejected attempt is recorded too, like every write.
    expect(actions).toEqual([
      'settings.achievements',
      'PUT /api/settings/achievements',
      'achievements.run',
    ]);
  });
});

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { linkUsers } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { berlinDayStart } from '../../domain/time.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

// The test context's clock is on 19 September 2026 (Berlin), so the "week" comparison is
// 12.–18. September against 5.–11. September.
const NOW = 1_789_800_000;

let database: AppDatabase;
let app: FastifyInstance;
let cookie: string;

function user(uid: string, firstSeen = berlinDayStart(20250101)): number {
  return database.sqlite
    .prepare(`INSERT INTO users (uid, first_seen, last_seen) VALUES (?, ?, ?) RETURNING id`)
    .pluck()
    .get(uid, firstSeen, NOW) as number;
}

function day(
  userId: number,
  dayKey: number,
  onlineS: number,
  { active = onlineS, unknown = 0, sessions = 1 } = {},
): void {
  database.sqlite
    .prepare(
      `INSERT INTO user_daily_stats (user_id, day, online_s, active_s, unknown_s, sessions)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, dayKey, onlineS, active, unknown, sessions);
}

function hour(ts: number, onlineS: number, maxOnline: number): void {
  database.sqlite
    .prepare(
      `INSERT INTO server_hourly (hour, online_s, max_online, unique_users) VALUES (?, ?, ?, ?)`,
    )
    .run(ts, onlineS, maxOnline, maxOnline);
}

async function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie } });
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

describe('GET /api/stats/trends', () => {
  it('compares the last week with the week before', async () => {
    const a = user('a');
    const b = user('b');
    const c = user('c', berlinDayStart(20260915));
    // Before: a and b, 2 h each. Now: a, b and the new c, 3 h each.
    day(a, 20260905, 7200);
    day(b, 20260910, 7200);
    day(a, 20260912, 10_800);
    day(b, 20260918, 10_800);
    day(c, 20260915, 10_800);
    // Today does not count yet.
    day(a, 20260919, 99_999);
    hour(berlinDayStart(20260906) + 20 * 3600, 7200, 2);
    hour(berlinDayStart(20260913) + 20 * 3600, 10_800, 3);

    const res = await get('/api/stats/trends?comparison=week');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      current: unknown;
      previous: unknown;
      metrics: Record<string, { current: number; previous: number; direction: string } | null>;
    }>();
    expect(body.current).toEqual({ fromDay: 20260912, toDay: 20260918 });
    expect(body.previous).toEqual({ fromDay: 20260905, toDay: 20260911 });
    expect(body.metrics.players).toMatchObject({ current: 3, previous: 2, direction: 'up' });
    expect(body.metrics.newPlayers).toMatchObject({ current: 1, previous: 0, direction: 'up' });
    expect(body.metrics.onlineS).toMatchObject({ current: 32_400, previous: 14_400 });
    expect(body.metrics.avgOnlinePerPlayerS).toMatchObject({ current: 10_800, previous: 7200 });
    expect(body.metrics.activeS).toMatchObject({ current: 32_400, previous: 14_400 });
    expect(body.metrics.sessions).toMatchObject({ current: 3, previous: 2 });
    expect(body.metrics.peakOnline).toMatchObject({ current: 3, previous: 2, direction: 'up' });
    expect(body.metrics.avgOnline?.current).toBeCloseTo(10_800 / (7 * 86_400));
  });

  it('counts linked accounts as one player', async () => {
    const a = user('a');
    const b = user('b');
    linkUsers(database.sqlite, a, b, 'admin', NOW);
    day(a, 20260913, 3600);
    day(b, 20260914, 3600);
    const body = (await get('/api/stats/trends?comparison=week')).json<{
      metrics: { players: { current: number } };
    }>();
    expect(body.metrics.players.current).toBe(1);
  });

  it('does not compare active time with an imported period', async () => {
    const a = user('a');
    day(a, 20260905, 7200, { active: 0, unknown: 7200 });
    day(a, 20260913, 7200);
    const body = (await get('/api/stats/trends?comparison=week')).json<{
      metrics: { activeS: unknown; avgActivePerPlayerS: unknown; onlineS: { direction: string } };
    }>();
    expect(body.metrics.activeS).toBeNull();
    expect(body.metrics.avgActivePerPlayerS).toBeNull();
    expect(body.metrics.onlineS.direction).toBe('flat');
  });

  it('defaults to the month comparison and works on an empty database', async () => {
    const res = await get('/api/stats/trends');
    expect(res.statusCode).toBe(200);
    const body = res.json<{ comparison: string; metrics: { players: { direction: string } } }>();
    expect(body.comparison).toBe('month');
    expect(body.metrics.players.direction).toBe('flat');
  });

  it('needs a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stats/trends' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/users/:id/trends', () => {
  it('compares a player with the same days of last year, including linked accounts', async () => {
    const a = user('a');
    const b = user('b');
    linkUsers(database.sqlite, a, b, 'admin', NOW);
    day(a, 20250901, 7200, { sessions: 2 });
    day(a, 20260901, 3600);
    day(b, 20260902, 3600);
    day(b, 20260903, 3600);

    const res = await get(`/api/users/${String(a)}/trends?comparison=year`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ previous: unknown; metrics: Record<string, unknown> }>();
    expect(body.previous).toEqual({ fromDay: 20250820, toDay: 20250918 });
    expect(body.metrics.onlineS).toMatchObject({
      current: 10_800,
      previous: 7200,
      direction: 'up',
    });
    expect(body.metrics.daysOnline).toMatchObject({ current: 3, previous: 1, direction: 'up' });
    expect(body.metrics.sessions).toMatchObject({ current: 3, previous: 2 });
    expect(body.metrics.avgSessionS).toMatchObject({
      current: 3600,
      previous: 3600,
      direction: 'flat',
    });
  });

  it('answers 404 for unknown and 410 for anonymized players', async () => {
    expect((await get('/api/users/999/trends')).statusCode).toBe(404);
    const a = user('a');
    database.sqlite.prepare(`UPDATE users SET anonymized_at = ? WHERE id = ?`).run(NOW, a);
    expect((await get(`/api/users/${String(a)}/trends`)).statusCode).toBe(410);
  });
});

describe('GET /api/leaderboards rank trend', () => {
  it('shows places gained or lost since the period before', async () => {
    const a = user('a');
    const b = user('b');
    const c = user('c');
    // Week of 6.–12. September: b ahead of a; 13.–19. September: a ahead of b, c is new.
    day(b, 20260908, 7200);
    day(a, 20260909, 3600);
    day(a, 20260915, 9000);
    day(b, 20260916, 5400);
    day(c, 20260917, 1800);

    const res = await get('/api/leaderboards?period=week');
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      previous: unknown;
      items: { userId: number; rank: number; rankChange: number | null }[];
    }>();
    expect(body.previous).toEqual({ fromDay: 20260906, toDay: 20260912 });
    expect(body.items.map((e) => [e.userId, e.rankChange])).toEqual([
      [a, 1],
      [b, -1],
      [c, null],
    ]);
  });

  it('has no trend for all time', async () => {
    database.sqlite
      .prepare(
        `INSERT INTO user_totals (user_id, online_s, active_s, sessions, first_seen, last_seen)
         VALUES (?, 3600, 3600, 1, ?, ?)`,
      )
      .run(user('a'), NOW, NOW);
    const body = (await get('/api/leaderboards')).json<{
      previous: unknown;
      items: { rankChange: number | null }[];
    }>();
    expect(body.previous).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.rankChange).toBeNull();
  });
});

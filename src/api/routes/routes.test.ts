import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeSegment, finalizeSession, rebuildAggregates } from '../../db/aggregates.js';
import type { AppDatabase } from '../../db/client.js';
import {
  openSegment,
  openSession,
  recordNickname,
  recordServerMinute,
  upsertChannels,
  upsertUser,
} from '../../db/repositories/index.js';
import { generateSyntheticData } from '../../db/synthetic.js';
import { createTestDatabase } from '../../db/testing.js';
import { berlinDayStart } from '../../domain/time.js';
import { createSilentLogger } from '../../logging/logger.js';
import { buildServer } from '../server.js';

const H = 3600;
const DAY1 = berlinDayStart(20260914); // Monday
const NOW = DAY1 + 3 * 86_400 + 12 * H; // Thursday noon

let database: AppDatabase;
let app: FastifyInstance;

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return {
    status: res.statusCode,
    body: res.json<Record<string, unknown> & { items?: unknown[] }>(),
  };
}

function user(uid: string, nick: string, seenAt = DAY1): number {
  const id = upsertUser(database.db, { uid, seenAt });
  recordNickname(database.db, id, nick, seenAt);
  return id;
}

function session(userId: number, joinAt: number, seconds: number, active = seconds): void {
  const sessionId = openSession(database.db, userId, joinAt);
  if (active > 0) {
    const seg = openSegment(database.db, {
      userId,
      sessionId,
      channelId: 1,
      state: 'active',
      startAt: joinAt,
    });
    finalizeSegment(database, seg, joinAt + active);
  }
  if (seconds > active) {
    const seg = openSegment(database.db, {
      userId,
      sessionId,
      channelId: 1,
      state: 'idle',
      startAt: joinAt + active,
    });
    finalizeSegment(database, seg, joinAt + seconds);
  }
  finalizeSession(database, sessionId, joinAt + seconds);
}

async function start(): Promise<void> {
  app = await buildServer({
    database,
    logger: createSilentLogger(),
    ts3: { state: 'connected' },
    now: () => NOW,
    startedAt: NOW - 100,
  });
}

afterEach(async () => {
  await app.close();
  database.close();
});

describe('with hand-made data', () => {
  let alice: number;
  let bob: number;

  beforeEach(async () => {
    database = createTestDatabase();
    upsertChannels(database.db, [{ id: 1, name: 'Lobby', seenAt: DAY1 }]);
    alice = user('uid-alice', 'Alice');
    bob = user('uid-bob', 'Bob', DAY1 + H);
    const casual = user('uid-casual', 'Casual', DAY1 + 2 * H);
    session(alice, DAY1 + 18 * H, 4 * H, 3 * H); // Monday
    session(alice, DAY1 - 20 * 86_400, 10 * H); // three weeks ago
    session(bob, DAY1 + 86_400 + 19 * H, 2 * H); // Tuesday
    session(bob, DAY1 + 2 * 86_400 + 19 * H, 2 * H); // Wednesday
    session(casual, DAY1 + 20 * H, 600);
    openSession(database.db, bob, NOW - 30 * 60); // Bob is online right now
    recordServerMinute(database.db, NOW - 60, 7);
    await start();
  });

  it('GET /api/stats/overview', async () => {
    const { status, body } = await get('/api/stats/overview?range=7d');
    expect(status).toBe(200);
    expect(body).toEqual({
      range: '7d',
      onlineNow: 1,
      peakToday: 7,
      peakInRange: 2,
      peakAllTime: 2,
      usersTotal: 3,
      usersNew: 3,
    });
  });

  it('GET /api/stats/online picks a resolution for the range', async () => {
    // No minute samples covering the last 24 h yet → hourly fallback.
    expect((await get('/api/stats/online?range=24h')).body.resolution).toBe(H);
    for (let t = NOW - 86_400; t < NOW; t += 300) recordServerMinute(database.db, t, 1);
    const day = await get('/api/stats/online?range=24h');
    expect(day.body).toMatchObject({ resolution: 300 });
    // 288 five-minute buckets, plus one partial bucket because the range is not aligned.
    expect(day.body.points).toHaveLength(289);
    const month = await get('/api/stats/online?range=30d');
    expect(month.body.resolution).toBe(H);
    const custom = await get(`/api/stats/online?from=${String(DAY1)}&to=${String(DAY1 + 86_400)}`);
    expect(custom.body.points).toEqual(
      expect.arrayContaining([{ t: DAY1 + 18 * H, avgOnline: 1, maxOnline: 1 }]),
    );
    const invalid = await get(`/api/stats/online?from=${String(NOW)}&to=${String(NOW - 1)}`);
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: 'INVALID_RANGE' } });
  });

  it('GET /api/stats/heatmap returns 7 × 24 values', async () => {
    const { body } = await get('/api/stats/heatmap?range=30d');
    const values = body.values as number[][];
    expect(values).toHaveLength(7);
    expect(values.every((row) => row.length === 24)).toBe(true);
    // Bob on Tuesday 19:00–21:00 Berlin time (DAY1 is Berlin midnight).
    expect(values[1]?.[19]).toBeGreaterThan(0);
    expect(values[1]?.[20]).toBeGreaterThan(0);
    expect(values[1]?.[21]).toBe(0);
  });

  it('GET /api/users hides casual users unless requested', async () => {
    const list = await get('/api/users');
    expect(list.body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(list.body.items).toEqual([
      expect.objectContaining({ nickname: 'Alice', onlineS: 14 * H, online: false }),
      expect.objectContaining({ nickname: 'Bob', onlineS: 4 * H, online: true }),
    ]);
    const all = await get('/api/users?includeCasual=true&sort=nickname&order=asc');
    expect((all.body.items as { nickname: string }[]).map((i) => i.nickname)).toEqual([
      'Alice',
      'Bob',
      'Casual',
    ]);
  });

  it('GET /api/users supports search and pagination and validates input', async () => {
    const search = await get('/api/users?search=bo');
    expect((search.body.items as { nickname: string }[]).map((i) => i.nickname)).toEqual(['Bob']);
    const page2 = await get('/api/users?pageSize=1&page=2');
    expect(page2.body).toMatchObject({ total: 2, page: 2 });
    expect(page2.body.items).toHaveLength(1);
    const invalid = await get('/api/users?sort=password&pageSize=1000');
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('GET /api/users/:id returns the player page data', async () => {
    const { status, body } = await get(`/api/users/${String(bob)}?days=30`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      user: { id: bob, uid: 'uid-bob', nickname: 'Bob' },
      online: { since: NOW - 30 * 60 },
      totals: { onlineS: 4 * H, activeS: 4 * H, sessions: 2, longestSessionS: 2 * H },
      nicknames: [{ nick: 'Bob' }],
      topChannels: [{ channelId: 1, name: 'Lobby', seconds: 4 * H }],
    });
    expect(body.daily).toHaveLength(2);
    expect(body.recentSessions).toHaveLength(3);

    const missing = await get('/api/users/9999');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'USER_NOT_FOUND' } });
  });

  it('GET /api/leaderboards for all periods and metrics', async () => {
    const all = await get('/api/leaderboards');
    expect(all.body).toMatchObject({ period: 'all', metric: 'online', total: 3, fromDay: null });
    expect((all.body.items as { nickname: string }[]).map((i) => i.nickname)).toEqual([
      'Alice',
      'Bob',
      'Casual',
    ]);

    const week = await get('/api/leaderboards?period=week&metric=active');
    expect(week.body).toMatchObject({ fromDay: 20260911, toDay: 20260917, total: 3 });
    expect((week.body.items as { value: number }[]).map((i) => i.value)).toEqual([
      4 * H,
      3 * H,
      600,
    ]);

    const longest = await get('/api/leaderboards?metric=longestSession&pageSize=1');
    expect(longest.body).toMatchObject({ total: 3, items: [{ nickname: 'Alice', value: 10 * H }] });

    const custom = await get('/api/leaderboards?period=custom&from=2026-09-15&to=2026-09-16');
    expect(custom.body).toMatchObject({ total: 1, items: [{ nickname: 'Bob', value: 4 * H }] });
  });

  it('GET /api/leaderboards rejects incomplete or invalid custom ranges', async () => {
    expect((await get('/api/leaderboards?period=custom')).status).toBe(400);
    expect(
      (await get('/api/leaderboards?period=custom&from=2026-09-16&to=2026-09-15')).status,
    ).toBe(400);
    const bad = await get('/api/leaderboards?period=custom&from=2026-02-30&to=2026-03-01');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('with synthetic data', () => {
  beforeEach(async () => {
    database = createTestDatabase();
    generateSyntheticData(database.sqlite, {
      years: 1,
      regularUsers: 25,
      casualUsers: 60,
      seed: 7,
      endAt: NOW,
    });
    rebuildAggregates(database);
    await start();
  });

  it('keeps all endpoints consistent with each other', async () => {
    const all = await get('/api/leaderboards?pageSize=100');
    const custom = await get(
      '/api/leaderboards?period=custom&from=2000-01-01&to=2100-01-01&pageSize=100',
    );
    expect(custom.body.items).toEqual(all.body.items);
    expect(custom.body.total).toBe(all.body.total);

    const users = await get('/api/users?includeCasual=true&pageSize=100');
    expect(users.body.total).toBe(85);
    const top = (users.body.items as { userId: number; onlineS: number }[])[0];
    expect(top).toMatchObject({
      userId: (all.body.items as { userId: number; value: number }[])[0]?.userId,
      onlineS: (all.body.items as { value: number }[])[0]?.value,
    });

    for (const url of [
      '/api/stats/overview?range=all',
      '/api/stats/online?range=all',
      '/api/stats/online?range=1y',
      '/api/stats/heatmap?range=all',
      `/api/users/${String(top?.userId)}`,
      '/api/leaderboards?period=year&metric=active',
    ]) {
      const res = await get(url);
      expect(res.status, url).toBe(200); // response schemas validated by the serializer
    }
    const series = await get('/api/stats/online?range=all');
    expect((series.body.points as unknown[]).length).toBeLessThanOrEqual(1000);
  });
});

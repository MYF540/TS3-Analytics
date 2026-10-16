import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { recordNickname, upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { berlinDayStart } from '../../domain/time.js';
import { runLoyaltyJob } from '../../loyalty/job.js';
import type { LoyaltyOverview, MissingRegulars } from '../../../web/src/api/types.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
const NOW = berlinDayStart(20261016) + 12 * H;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let viewer: string;

function player(uid: string, nick: string): number {
  const id = upsertUser(database.db, { uid, seenAt: berlinDayStart(20260101) });
  recordNickname(database.db, id, nick, berlinDayStart(20260101));
  return id;
}

function online(userId: number, day: number, seconds: number): void {
  database.sqlite
    .prepare(`INSERT INTO user_daily_stats (user_id, day, online_s) VALUES (?, ?, ?)`)
    .run(userId, day, seconds);
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

const get = async (url: string, cookie = viewer) => {
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  return res;
};

/** Alice: regular, gone since September. Bob: regular, still around. Carl: rarely there. */
function seed() {
  const alice = player('a', 'Alice');
  const bob = player('b', 'Bob');
  const carl = player('c', '=Carl');
  online(alice, 20260801, 15 * H);
  online(alice, 20260910, 10 * H);
  online(bob, 20260801, 30 * H);
  online(bob, 20261014, H);
  online(carl, 20260801, H);
  database.sqlite
    .prepare(
      `INSERT INTO ranks (id, name, sort_order, required_s, server_group_id, created_at, updated_at)
       VALUES (1, 'Stammgast', 1, 0, 100, 0, 0)`,
    )
    .run();
  database.sqlite
    .prepare(`INSERT INTO rank_state (user_id, rank_id, decided_at) VALUES (?, 1, 0)`)
    .run(alice);
  runLoyaltyJob(database, NOW);
  return { alice, bob, carl };
}

describe('GET /api/loyalty', () => {
  it('is empty before the first run', async () => {
    const res = await get('/api/loyalty');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      computedAt: null,
      returnAfterDays: [7, 30, 90],
      cohorts: [],
      months: [],
    });
  });

  it('returns cohorts and the monthly balance from the cache', async () => {
    seed();
    const body = (await get('/api/loyalty')).json<LoyaltyOverview>();
    expect(body.computedAt).toBe(NOW);
    expect(body.cohorts).toEqual([
      { month: 202608, size: 3, eligible: [3, 3, 0], returned: [2, 2, 0] },
    ]);
    expect(body.months.map((m) => m.month)).toEqual([202608, 202609, 202610]);
    expect(body.months[0]).toEqual({
      month: 202608,
      active: 3,
      newcomers: 3,
      returners: 0,
      lost: 1,
    });
    expect(body.months[1]).toMatchObject({ active: 1, lost: 1 });
  });
});

describe('GET /api/loyalty/missing', () => {
  it('lists regulars who are away, with the defaults of 20 h and 4 weeks', async () => {
    const { alice } = seed();
    const body = (await get('/api/loyalty/missing')).json<MissingRegulars>();
    expect(body).toMatchObject({ computedAt: NOW, total: 1, page: 1, pageSize: 50 });
    expect(body.items).toEqual([
      {
        userId: alice,
        nickname: 'Alice',
        lastDay: 20260910,
        recentS: 25 * H,
        totalS: 25 * H,
        rank: 'Stammgast',
      },
    ]);
  });

  it('takes the hours and weeks from the query', async () => {
    const { bob } = seed();
    const fewHours = (
      await get('/api/loyalty/missing?minHours=0.5&weeks=4')
    ).json<MissingRegulars>();
    expect(fewHours.items.map((i) => i.nickname)).toEqual(['Alice', '=Carl']);
    const recent = (await get('/api/loyalty/missing?minHours=20&weeks=1')).json<MissingRegulars>();
    expect(recent.items.map((i) => i.nickname)).toEqual(['Alice']);
    // Bob was online two days ago.
    expect(recent.items.some((i) => i.userId === bob)).toBe(false);
    expect((await get('/api/loyalty/missing?weeks=0')).statusCode).toBe(400);
  });

  it('exports the list as CSV', async () => {
    seed();
    const res = await get('/api/loyalty/missing.csv?minHours=0.5');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('vermisste-stammspieler.csv');
    const lines = res.body.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toBe(
      'Spieler-ID;Nickname;Letzter Besuch;Spielzeit 90 Tage vor letztem Besuch (h);Spielzeit (h);Spielzeit (s);Rang',
    );
    expect(lines[1]).toBe('1;Alice;2026-09-10;25;25;90000;Stammgast');
    // Nicknames are neutralised against formula injection.
    expect(lines[2]).toBe("3;'=Carl;2026-08-01;1;1;3600;");
  });
});

describe('POST /api/loyalty/run', () => {
  it('recomputes for admins and writes the audit log', async () => {
    player('a', 'Alice');
    online(1, 20260801, H);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/loyalty/run',
      headers: { cookie: viewer },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST',
      url: '/api/loyalty/run',
      headers: { cookie: admin },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<LoyaltyOverview>().cohorts).toHaveLength(1);
    const actions = database.sqlite
      .prepare(`SELECT action FROM audit_log WHERE action = 'loyalty.run'`)
      .pluck()
      .all();
    expect(actions).toEqual(['loyalty.run']);
  });
});

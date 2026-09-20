import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeSegment, finalizeSession } from '../../db/aggregates.js';
import type { AppDatabase } from '../../db/client.js';
import {
  openSegment,
  openSession,
  upsertChannels,
  upsertUser,
} from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;
const H = 3600;

let database: AppDatabase;
let app: FastifyInstance;
let cookie: string;

function visit(userId: number, channelId: number, startAt: number, seconds: number): void {
  const sessionId = openSession(database.db, userId, startAt);
  const seg = openSegment(database.db, {
    userId,
    sessionId,
    channelId,
    state: 'active',
    startAt,
  });
  finalizeSegment(database, seg, startAt + seconds);
  finalizeSession(database, sessionId, startAt + seconds);
}

beforeEach(async () => {
  database = createTestDatabase();
  upsertChannels(database.db, [
    { id: 1, name: 'Lobby', seenAt: NOW },
    { id: 2, name: 'Zocken', seenAt: NOW },
  ]);
  const alice = upsertUser(database.db, { uid: 'uid-alice', seenAt: NOW - 30 * 86_400 });
  visit(alice, 1, NOW - 3 * 86_400, 2 * H);
  visit(alice, 2, NOW - 20 * 86_400, H);
  const context = createTestContext(database);
  cookie = sessionCookie(context);
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('GET /api/channels/usage', () => {
  it('returns the channels of the range, busiest first', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels/usage?range=30d',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      range: '30d',
      from: NOW - 30 * 86_400,
      to: NOW,
      total: 2,
      totalSeconds: 3 * H,
      items: [
        {
          channelId: 1,
          name: 'Lobby',
          seconds: 2 * H,
          users: 1,
          visits: 1,
          lastUsed: NOW - 3 * 86_400 + 2 * H,
          present: true,
        },
        {
          channelId: 2,
          name: 'Zocken',
          seconds: H,
          users: 1,
          visits: 1,
          lastUsed: NOW - 20 * 86_400 + H,
          present: true,
        },
      ],
    });
  });

  it('defaults to 30 days and honours a shorter range', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels/usage?range=7d',
      headers: { cookie },
    });
    const body = res.json<{ items: { channelId: number }[] }>();
    expect(body.items.map((item) => item.channelId)).toEqual([1]);
  });

  it('refuses a range the raw segments cannot answer fast enough', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels/usage?range=1y',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it('needs a login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/channels/usage' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/channels/unused', () => {
  it('lists channels without visits in the period', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels/unused?days=7',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      days: 7,
      since: NOW - 7 * 86_400,
      items: [{ channelId: 2, name: 'Zocken', lastSeen: NOW }],
    });
  });

  it('rejects a period it has no data for', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/channels/unused?days=365',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});

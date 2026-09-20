import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeSegment, finalizeSession } from '../../db/aggregates.js';
import type { AppDatabase } from '../../db/client.js';
import {
  openSegment,
  openSession,
  recordNickname,
  upsertChannels,
  upsertUser,
} from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { runNetworkJob } from '../../network/job.js';
import { loadNetworkSettings } from '../../network/settings.js';
import { loadActivitySettings, saveActivitySettings } from '../../watcher/settings.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const H = 3600;
const NOW = 1_789_800_000;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;

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
    { id: 1, name: 'Talk', seenAt: NOW },
    { id: 9, name: 'AFK', seenAt: NOW },
  ]);
  saveActivitySettings(
    database.db,
    { ...loadActivitySettings(database.db), afkChannelIds: [9] },
    NOW,
  );
  const context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

const get = (cookie = admin) =>
  app.inject({ method: 'GET', url: '/api/settings/network', headers: { cookie } });

describe('GET /api/settings/network', () => {
  it('returns settings, defaults and the channels to choose from', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      settings: { candidates: number; excludedChannelIds: number[] };
      defaults: { candidates: number };
      channels: { id: number; name: string; afk: boolean }[];
      state: unknown;
    }>();
    expect(body.settings).toEqual(body.defaults);
    expect(body.settings.excludedChannelIds).toEqual([]);
    // listChannels sorts by name, which is also the order the picker wants.
    expect(body.channels).toEqual([
      { id: 9, name: 'AFK', lastSeen: NOW, afk: true },
      { id: 1, name: 'Talk', lastSeen: NOW, afk: false },
    ]);
    expect(body.state).toBe(null);
  });

  it('is admin only', async () => {
    expect((await get(moderator)).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/settings/network' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/network', () => {
  /** Three players: a and b spend a lot of time together, c only briefly with a. */
  function network(): { a: number; b: number; c: number } {
    const a = upsertUser(database.db, { uid: 'uid-a', seenAt: NOW - 10 * 86_400 });
    const b = upsertUser(database.db, { uid: 'uid-b', seenAt: NOW - 10 * 86_400 });
    const c = upsertUser(database.db, { uid: 'uid-c', seenAt: NOW - 10 * 86_400 });
    recordNickname(database.db, a, 'Alice', NOW);
    recordNickname(database.db, b, 'Bob', NOW);
    visit(a, 1, NOW - 86_400, 10 * H);
    visit(b, 1, NOW - 86_400, 10 * H);
    visit(c, 1, NOW - 86_400, 2 * H);
    return { a, b, c };
  }

  it('returns the strongest connections with nicknames and shares', async () => {
    const { a, b } = network();
    runNetworkJob(database, NOW);

    const res = await app.inject({
      method: 'GET',
      url: '/api/network?range=30d',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      computedAt: number;
      edges: { a: number; b: number; seconds: number; shareA: number }[];
      nodes: { userId: number; nickname: string | null; seconds: number }[];
      edgesTotal: number;
      strongestS: number;
    }>();
    expect(body.computedAt).toBe(NOW);
    expect(body.edges[0]).toMatchObject({ a: Math.min(a, b), b: Math.max(a, b), seconds: 10 * H });
    expect(body.edges[0]?.shareA).toBeCloseTo(1);
    expect(body.nodes.map((n) => n.nickname)).toContain('Alice');
    expect(body.edgesTotal).toBe(3);
    expect(body.strongestS).toBe(10 * H);
  });

  it('draws only as many connections as the slider asks for', async () => {
    network();
    runNetworkJob(database, NOW);
    const res = await app.inject({
      method: 'GET',
      url: '/api/network?range=30d&limit=10',
      headers: { cookie: admin },
    });
    const body = res.json<{ edges: unknown[]; edgesTotal: number }>();
    expect(body.edges).toHaveLength(3);
    expect(body.edgesTotal).toBe(3);
  });

  it('answers with an empty graph while the job never ran', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/network',
      headers: { cookie: admin },
    });
    expect(res.json()).toMatchObject({ computedAt: null, nodes: [], edges: [], edgesTotal: 0 });
  });

  it('refuses a window it does not know', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/network?range=7d',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(400);
  });

  it('is admin only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/network',
      headers: { cookie: moderator },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /api/settings/network', () => {
  const body = {
    excludedChannelIds: [2, 1, 2],
    candidates: 50,
    minEncounterS: 600,
    minPairS: 3600,
  };

  it('saves the settings, sorted and without duplicates, and writes the audit log', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/network',
      headers: { cookie: admin },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(loadNetworkSettings(database.db)).toMatchObject({
      excludedChannelIds: [1, 2],
      candidates: 50,
    });
    const audit = database.sqlite
      .prepare(`SELECT action, target_id AS targetId FROM audit_log ORDER BY id DESC`)
      .get() as { action: string; targetId: string };
    expect(audit).toEqual({ action: 'settings.network', targetId: 'network' });
  });

  it('refuses values outside the allowed range', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/network',
      headers: { cookie: admin },
      payload: { ...body, candidates: 5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('is admin only', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/network',
      headers: { cookie: moderator },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/settings/network/run', () => {
  it('computes the network right away and reports the result', async () => {
    const a = upsertUser(database.db, { uid: 'uid-a', seenAt: NOW - 86_400 });
    const b = upsertUser(database.db, { uid: 'uid-b', seenAt: NOW - 86_400 });
    visit(a, 1, NOW - 86_400, 2 * H);
    visit(b, 1, NOW - 86_400, 2 * H);

    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/network/run',
      headers: { cookie: admin },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json<{ state: { computedAt: number; ranges: Record<string, unknown> } }>()
      .state;
    expect(state.computedAt).toBe(NOW);
    expect(state.ranges['30d']).toMatchObject({ nodes: 2, edges: 1 });
    expect(
      database.sqlite.prepare(`SELECT count(*) FROM network_edges`).pluck().get(),
    ).toBeGreaterThan(0);
    const audit = database.sqlite
      .prepare(`SELECT action FROM audit_log ORDER BY id DESC`)
      .pluck()
      .get();
    expect(audit).toBe('network.run');
  });

  it('is admin only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/network/run',
      headers: { cookie: moderator },
    });
    expect(res.statusCode).toBe(403);
  });
});

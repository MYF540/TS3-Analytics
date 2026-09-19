import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { upsertChannels } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { loadActivitySettings } from '../../watcher/settings.js';
import { listAudit } from '../audit/audit.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;

const valid = {
  idleThresholdS: 900,
  afkChannelIds: [7, 3, 7],
  awayIsAfk: false,
  outputMutedIsAfk: true,
};

beforeEach(async () => {
  database = createTestDatabase();
  upsertChannels(database.db, [
    { id: 3, name: 'afk', seenAt: 10 },
    { id: 7, name: 'Abwesend', seenAt: 20 },
    { id: 1, name: 'Lobby', seenAt: 30 },
  ]);
  const context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

describe('activity settings', () => {
  it('returns current settings, defaults and all channels by name', async () => {
    const res = await app.inject({ url: '/api/settings/activity', headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ settings: unknown; defaults: unknown; channels: { name: string }[] }>();
    expect(body.settings).toEqual(body.defaults);
    expect(body.channels.map((c) => c.name)).toEqual(['Abwesend', 'afk', 'Lobby']);
  });

  it('saves settings, deduplicates channels and audits the changed fields', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings/activity',
      headers: { cookie: admin },
      payload: valid,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...valid, afkChannelIds: [3, 7] });
    expect(loadActivitySettings(database.db)).toEqual({ ...valid, afkChannelIds: [3, 7] });

    const [entry] = listAudit(database.sqlite, {}, { limit: 1, offset: 0 }).items;
    expect(entry).toMatchObject({
      action: 'settings.activity',
      status: 200,
      details: {
        idleThresholdS: { from: 600, to: 900 },
        afkChannelIds: { from: [], to: [3, 7] },
        awayIsAfk: { from: true, to: false },
      },
    });
    expect(entry?.details).not.toHaveProperty('outputMutedIsAfk');
  });

  it('rejects out-of-range values and incomplete bodies', async () => {
    for (const payload of [
      { ...valid, idleThresholdS: 30 },
      { ...valid, idleThresholdS: 90_000 },
      { ...valid, afkChannelIds: [0] },
      { idleThresholdS: 600 },
    ]) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings/activity',
        headers: { cookie: admin },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(loadActivitySettings(database.db).idleThresholdS).toBe(600);
  });

  it('is admin-only', async () => {
    const get = await app.inject({ url: '/api/settings/activity', headers: { cookie: moderator } });
    expect(get.statusCode).toBe(403);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/activity',
      headers: { cookie: moderator },
      payload: valid,
    });
    expect(put.statusCode).toBe(403);
  });
});

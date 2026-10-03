import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listManaged } from '../../automation/managed-channels.js';
import { loadChannelsSettings } from '../../automation/modules/channels.js';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import type { Ts3Channel } from '../../ts3/types.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;
let online: boolean;

function channel(cid: number, name: string, pid: number): Ts3Channel {
  return {
    cid,
    pid,
    name,
    order: 0,
    totalClients: 0,
    maxClients: -1,
    kind: 'permanent',
    hasPassword: false,
  };
}

const serverChannels = [
  channel(50, 'Gespräche', 0),
  channel(60, 'Talk 1', 50),
  channel(61, 'Talk 2', 50),
  channel(62, 'Besprechung', 50),
  channel(63, 'Talk 3', 0),
];

beforeEach(async () => {
  online = true;
  database = createTestDatabase();
  const context = createTestContext(database, {
    channels: () =>
      online ? Promise.resolve(serverChannels) : Promise.reject(new Error('not connected')),
  });
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

const put = (payload: Record<string, unknown>, cookie = admin) =>
  app.inject({ method: 'PUT', url: '/api/automation/channels', headers: { cookie }, payload });
const adopt = (areaId: string, cookie = admin) =>
  app.inject({
    method: 'POST',
    url: '/api/automation/channels/adopt',
    headers: { cookie },
    payload: { areaId },
  });

const area = { id: 'talk', parentId: 50, prefix: 'Talk' };

describe('channel creator routes', () => {
  it('save areas with their defaults and report how many channels are managed', async () => {
    const response = await put({ enabled: true, areas: [area] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        enabled: true,
        dryRun: true,
        areas: [{ ...area, naming: 'numbered', minFree: 1, maxChannels: 20, codecQuality: 6 }],
      },
      managed: [{ areaId: 'talk', count: 0 }],
    });
    expect(database.sqlite.prepare('SELECT action FROM audit_log ORDER BY id DESC').get()).toEqual({
      action: 'automation.channels',
    });
  });

  it('refuse areas that cannot work and say why', async () => {
    const response = await put({
      areas: [
        { id: 'a', parentId: 50, prefix: '' },
        { id: 'b', parentId: 51, naming: 'list', names: ['Rot', 'Rot'] },
        { id: 'c', parentId: 52, prefix: 'X' },
        { id: 'c', parentId: 53, prefix: 'Y' },
        { id: 'd', parentId: 54, prefix: 'Z' },
        { id: 'e', parentId: 54, prefix: 'W' },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: 'CHANNELS_INVALID_AREA',
        details: [
          { index: 0, problem: 'prefix' },
          { index: 1, problem: 'names' },
          { index: 2, problem: 'id' },
          { index: 3, problem: 'id' },
          { index: 4, problem: 'parent' },
          { index: 5, problem: 'parent' },
        ],
      },
    });
    expect(loadChannelsSettings(database.db).areas).toEqual([]);
  });

  it('adopt the channels below the parent that fit the naming, and only those', async () => {
    await put({ areas: [area] });
    const response = await adopt('talk');
    expect(response.json()).toEqual({ adopted: 2 });
    expect(listManaged(database.db, 'channels', 'talk').map((e) => e.channelId)).toEqual([60, 61]);
    // A second run finds nothing new.
    expect((await adopt('talk')).json()).toEqual({ adopted: 0 });
    expect(
      database.sqlite
        .prepare('SELECT details FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 1')
        .get(),
    ).toEqual({ details: JSON.stringify({ areaId: 'talk', channels: ['Talk 1', 'Talk 2'] }) });
  });

  it('cannot adopt for an unknown area or while the bot is offline', async () => {
    expect((await adopt('nix')).json()).toMatchObject({ error: { code: 'AREA_NOT_FOUND' } });
    await put({ areas: [area] });
    online = false;
    const response = await adopt('talk');
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'BOT_OFFLINE' } });
  });

  it('are for admins only', async () => {
    expect((await put({ areas: [area] }, moderator)).statusCode).toBe(403);
    expect((await adopt('talk', moderator)).statusCode).toBe(403);
  });
});
